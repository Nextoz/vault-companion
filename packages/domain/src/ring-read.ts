import { HEALTH_VITALS_DAILY_CSV, RingDailyRow, ringSlotsPath, type ApiError, type RingDayResponse, type RingSlot, type RingVitals } from '@vault-companion/contracts';
import { isStructurallySafePath } from './paths.ts';
import { RING_DAILY_HEADER } from './ring-metrics.ts';
import { parseSlotFile, ringFileHeader, ringFileLines } from './ring-slot-file.ts';
import { canonicalSlotStart } from './ring-slots.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';
import { userDate } from './time.ts';

type Deps = { store: VaultStore; now: () => Date; timeZone: string };
type IndexedMonth = { header: string; dates: string[]; rows: { raw: string; start: string; instant: number }[] };
class Unreadable extends Error {}
const STORED_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/;
// Canonical dates depend only on zone and instant, even when a new revision changes values.
// Bound retained entries to roughly three months; never cache row validation or file contents.
const indexedDates = new Map<number, string>();
let indexedTimeZone: string | undefined;
function indexedDate(instant: number, timeZone: string): string {
  if (indexedTimeZone !== timeZone) {
    indexedDates.clear();
    indexedTimeZone = timeZone;
  }
  const cached = indexedDates.get(instant);
  if (cached !== undefined) return cached;
  const date = canonicalSlotStart(instant, timeZone).slice(0, 10);
  if (indexedDates.size === 8192) indexedDates.clear();
  indexedDates.set(instant, date);
  return date;
}
const shiftDay = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export function validRingDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}
export function ringDayBounds(date: string, tz: string) {
  const midnight = (day: string) => {
    const utc = Date.parse(`${day}T00:00:00Z`);
    let instant = utc;
    for (let i = 0; i < 3; i++) instant += utc - Date.parse(`${canonicalSlotStart(instant, tz).slice(0, 19)}Z`);
    return instant;
  };
  const start = midnight(date), end = midnight(shiftDay(date, 1));
  return { dayStart: canonicalSlotStart(start, tz), dayEnd: canonicalSlotStart(end, tz), daySlots: (end - start) / 900000 as 92 | 96 | 100 };
}
/** Fixed names, pinned tree/blob identity and byte fidelity, matching the health reader. */
async function readText(store: VaultStore, revision: string, path: string): Promise<string | null> {
  if (!isStructurallySafePath(path)) throw new Unreadable();
  try {
    const listed = (await store.listFiles(path.slice(0, path.lastIndexOf('/')), revision)).find((f) => f.path === path);
    if (!listed) return null;
    const file = await store.readFile(path as VaultPath, revision);
    if (!file || file.blobSha !== listed.blobSha || file.bytes.length > 1024 * 1024) throw new Unreadable();
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); } catch { throw new Unreadable(); }
  } catch (e) { if (e instanceof FileTooLarge) throw new Unreadable(); throw e; }
}
export function parseRingDaily(text: string): RingDailyRow[] {
  const lines = ringFileLines(text);
  if (ringFileHeader(lines) !== RING_DAILY_HEADER) throw new Unreadable();
  const columns = RING_DAILY_HEADER.split(','), seen = new Set<string>();
  return lines.slice(1).map(({ raw }) => {
    const cells = raw.split(','), value: Record<string, unknown> = {};
    if (cells.length !== columns.length) throw new Unreadable();
    columns.forEach((column, i) => {
      if (column === 'weekday') return;
      const key = column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), cell = cells[i]!;
      value[key] = column === 'date' ? cell : cell === '' ? null : ['sleep_start', 'sleep_end'].includes(column) ? cell : /^\d+(?:\.\d+)?$/.test(cell) ? Number(cell) : NaN;
    });
    const parsed = RingDailyRow.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.date)) throw new Unreadable();
    seen.add(parsed.data.date); return parsed.data;
  });
}
const emptyVitals = (status: 'missing' | 'unreadable'): RingVitals => ({ status, row: null, daySlots: null, staleDays: null });
export async function readRingVitals(deps: Deps, revision: string, at: Date): Promise<RingVitals> {
  try {
    const text = await readText(deps.store, revision, HEALTH_VITALS_DAILY_CSV);
    const today = userDate(at, deps.timeZone);
    const row = text === null ? undefined : parseRingDaily(text).filter((r) => r.date <= today).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    return row ? { status: 'ok', row, daySlots: ringDayBounds(row.date, deps.timeZone).daySlots, staleDays: (Date.parse(today) - Date.parse(row.date)) / 86400000 } : emptyVitals('missing');
  } catch { return emptyVitals('unreadable'); }
}
export async function readRingDay(deps: Deps, date: string): Promise<RingDayResponse | ApiError> {
  const at = deps.now(), today = userDate(at, deps.timeZone);
  if (!validRingDate(date) || date > today) return { code: 'invalid', message: 'invalid date', retryable: false };
  try {
    const { commitSha: revision } = await deps.store.head();
    const base = { revision, now: at.toISOString(), today, date, ...ringDayBounds(date, deps.timeZone) };
    try {
      const month = date.slice(0, 7);
      const load = async (m: string): Promise<IndexedMonth> => {
        const text = await readText(deps.store, revision, ringSlotsPath(m));
        if (text === null) return { header: '', dates: [], rows: [] };
        // Match ringFileLines' mixed-EOL and final-newline semantics without match objects.
        const lines = text.split(/\r\n|\r|\n/);
        if (lines.at(-1) === '') lines.pop();
        const header = ringFileHeader(lines.length ? [{ raw: lines[0]!, end: '' }] : []);
        if (header === undefined || !parseSlotFile(header).ok) throw new Unreadable();
        const dates = new Set<string>(), rows: IndexedMonth['rows'] = [];
        for (const raw of lines.slice(1)) {
          const comma = raw.indexOf(',');
          // The stored start shape first: bare Date.parse also accepts loose text (e.g. "1" is a date in 2001).
          const start = comma < 0 ? raw : raw.slice(0, comma), instant = STORED_START.test(start) ? Date.parse(start) : NaN;
          if (!Number.isFinite(instant)) throw new Unreadable();
          const localDate = indexedDate(instant, deps.timeZone);
          if (localDate <= today) dates.add(localDate);
          if (localDate === date) rows.push({ raw, start, instant });
        }
        return { header, dates: [...dates].sort(), rows };
      };
      const slots = await load(month);
      const here = slots.dates;
      let prevDate = here.filter((d) => d < date).at(-1) ?? null;
      let nextDate = here.find((d) => d > date) ?? null;
      if (!prevDate) prevDate = (await load(shiftDay(`${month}-01`, -1).slice(0, 7))).dates.filter((d) => d < date).at(-1) ?? null;
      const nextMonth = shiftDay(`${month}-01`, 32).slice(0, 7);
      if (!nextDate && nextMonth <= today.slice(0, 7)) nextDate = (await load(nextMonth)).dates.find((d) => d > date) ?? null;
      const daily = await readText(deps.store, revision, HEALTH_VITALS_DAILY_CSV);
      const night = daily === null ? null : parseRingDaily(daily).find((r) => r.date === date) ?? null;
      const selected = slots.rows.sort((a, b) => a.instant - b.instant);
      const day: RingSlot[] = [];
      if (selected.length) {
        // Reuse the stored-row rules, including duplicate-instant rejection, only for this day.
        const parsed = parseSlotFile(`${slots.header}\n${selected.map((s) => s.raw).join('\n')}`);
        if (!parsed.ok) throw new Unreadable();
        day.push(...parsed.slots.map((s, i) => ({ start: selected[i]!.start, values: s.values })));
      }
      return { ...base, status: day.length ? 'ok' : 'missing', slots: day, night, prevDate, nextDate };
    } catch (e) {
      if (e instanceof Unreadable) return { ...base, status: 'unreadable', slots: [], night: null, prevDate: null, nextDate: null };
      throw e;
    }
  } catch (e) {
    if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
    throw e;
  }
}
