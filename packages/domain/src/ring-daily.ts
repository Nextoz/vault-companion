import { formatNumber, weekday } from './health-format.ts';
import { RING_DAILY_HEADER, RING_DAILY_HEADER_V1, RING_METRICS, type RingDailyAgg, type RingKey } from './ring-metrics.ts';
import { canonicalSlotStart, type RingSlot } from './ring-slots.ts';
import { firstEol, joinRingLines, ringFileHeader, ringFileLines, ringStructureRefusal, type RingFileMerge } from './ring-slot-file.ts';

const SLOT_MS = 15 * 60_000, SESSION_GAP_MS = 75 * 60_000, DAY_MS = 86_400_000;
const NIGHT_CUT_HOURS = 3;
const localClocks = new Map<string, number>();
// Shift the local clock, rather than the instant, across DST boundaries.
function wallClockDate(ms: number, tz: string, shiftHours: number): string {
  const key = `${tz}|${ms}`;
  let local = localClocks.get(key);
  if (local === undefined) {
    local = Date.parse(`${canonicalSlotStart(ms, tz).slice(0, 19)}Z`);
    if (localClocks.size >= 4096) localClocks.clear();
    localClocks.set(key, local);
  }
  return new Date(local + shiftHours * 3_600_000).toISOString().slice(0, 10);
}
export type RingNightSession = { start: number; end: number; date: string; slots: RingSlot[] };
const byInstant = (a: RingSlot, b: RingSlot) => a.instant - b.instant;
/** A sleep slot has light + deep + awake minutes (the registry's `sleep` sum group) > 0. */
export const isSleepSlot = (s: RingSlot): boolean =>
  RING_METRICS.reduce((sum, m) => sum + (m.sumGroup?.id === 'sleep' ? s.values[m.key] ?? 0 : 0), 0) > 0;

/** Sleep slots form one session while consecutive starts are <= 75 min apart; night date = wall-clock (end - 3 h). */
export function ringNightSessions(slots: readonly RingSlot[], tz: string): RingNightSession[] {
  const sessions: RingNightSession[] = [];
  for (const slot of slots.filter(isSleepSlot).sort(byInstant)) {
    const last = sessions.at(-1), lastStart = last ? last.end - SLOT_MS : -Infinity;
    if (last && slot.instant - lastStart <= SESSION_GAP_MS) { last.slots.push(slot); last.end = slot.instant + SLOT_MS; }
    else sessions.push({ start: slot.instant, end: slot.instant + SLOT_MS, date: '', slots: [slot] });
  }
  for (const s of sessions) s.date = wallClockDate(s.end, tz, -NIGHT_CUT_HOURS);
  return sessions;
}
/** The night of `date`: the longest session with that night date; a tie goes to the later one. */
export function ringNight(sessions: readonly RingNightSession[], date: string): RingNightSession | undefined {
  let night: RingNightSession | undefined;
  for (const s of sessions) if (s.date === date && (!night || s.end - s.start >= night.end - night.start)) night = s;
  return night;
}
/** Dates whose daily row a send can change (rows are then derived from the merged slots). */
export function affectedDates(sent: readonly RingSlot[], merged: readonly RingSlot[], tz: string): string[] {
  const dates = new Set<string>(), sessions = ringNightSessions(merged, tz);
  for (const s of sent) {
    dates.add(wallClockDate(s.instant, tz, 0));
    // Night values (resting HR) read every slot inside a session, sleep slot or not.
    for (const n of sessions) if (s.instant >= n.start && s.instant < n.end) dates.add(n.date);
    // A new sleep slot can join a session that ended <= 60 min before it, whose former night date then loses it.
    if (isSleepSlot(s)) for (const h of [NIGHT_CUT_HOURS, NIGHT_CUT_HOURS + 1]) dates.add(wallClockDate(s.instant, tz, -h));
  }
  return [...dates].sort();
}
/** Slots per Copenhagen calendar date for `dates` only; slots far from them skip the costly zone lookup. */
export function slotsByDate(slots: readonly RingSlot[], dates: readonly string[], tz: string): Map<string, RingSlot[]> {
  const byDate = new Map(dates.map((d) => [d, [] as RingSlot[]])), days = dates.map((d) => Date.parse(`${d}T00:00:00Z`));
  const from = Math.min(...days) - DAY_MS, to = Math.max(...days) + 2 * DAY_MS;
  for (const s of slots) if (s.instant >= from && s.instant < to) byDate.get(wallClockDate(s.instant, tz, 0))?.push(s);
  return byDate;
}
const median = (sorted: readonly number[]) => (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2;
/** One registry aggregation over a scope's non-null values; null = empty cell. */
export function ringAggregate(agg: RingDailyAgg, values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  if (agg.fn === 'count') return n;
  // A night without minutes of a stage has a real 0 of it; any other empty scope stays missing.
  if (n < (agg.minCount ?? 1)) return agg.fn === 'sum' && agg.scope === 'night' ? 0 : null;
  const sum = sorted.reduce((a, b) => a + b, 0);
  switch (agg.fn) {
    case 'sum': return sum;
    case 'mean': return sum / n;
    case 'min': return sorted[0]!;
    case 'median': return median(sorted);
  }
}
const valuesOf = (slots: readonly RingSlot[], key: RingKey) => slots.map((s) => s.values[key]).filter((v): v is number => v != null);
/** Full calendar grid in instant order, including both occurrences of a repeated DST hour. */
function coverage(day: readonly RingSlot[], date: string, tz: string): Record<string, string> {
  if (!day.length) return {};
  const midnight = (utc: number) => {
    let instant = utc;
    for (let i = 0; i < 3; i++) instant += utc - Date.parse(`${canonicalSlotStart(instant, tz).slice(0, 19)}Z`);
    return instant;
  };
  const utc = Date.parse(`${date}T00:00:00Z`), end = midnight(utc + DAY_MS);
  const readings = new Map(day.filter((s) => RING_METRICS.some((m) => s.values[m.key] != null)).map((s) => [s.instant, s]));
  let mask = '', gap = 0, longest = 0;
  for (let instant = midnight(utc); instant < end; instant += SLOT_MS) {
    const s = readings.get(instant);
    mask += !s ? '-' : (s.values.sleepLightMin ?? 0) > 0 || (s.values.sleepDeepMin ?? 0) > 0 ? '1' : '0';
    gap = s ? 0 : gap + 1;
    longest = Math.max(longest, gap);
  }
  return { slots_n: String(readings.size), longest_gap_min: String(longest * 15), sleep_mask: mask };
}
export function deriveRingDaily(slots: readonly RingSlot[], dates: readonly string[], tz: string): Map<string, string> {
  const rows = new Map<string, string>(), sessions = ringNightSessions(slots, tz), byDate = slotsByDate(slots, dates, tz);
  for (const date of dates) {
    const day = byDate.get(date) ?? [], night = ringNight(sessions, date);
    if (!day.length && !night) continue;
    // Night scope: every slot in [sleep_start, sleep_end), sleep slot or not; null without a session.
    const nightSlots = night ? slots.filter((s) => s.instant >= night.start && s.instant < night.end) : null;
    const cells: Record<string, string> = {
      ...coverage(day, date, tz),
      date, weekday: weekday(date), sleep_n: String(night?.slots.length ?? 0),
      sleep_start: night ? canonicalSlotStart(night.start, tz) : '', sleep_end: night ? canonicalSlotStart(night.end, tz) : '',
    };
    for (const m of RING_METRICS) for (const agg of m.daily) {
      const scope = agg.scope === 'day' ? day : nightSlots, value = scope && ringAggregate(agg, valuesOf(scope, m.key));
      cells[agg.column] = value == null ? '' : formatNumber(value, agg.decimals);
    }
    rows.set(date, RING_DAILY_HEADER.split(',').map((c) => cells[c] ?? '').join(','));
  }
  return rows;
}
export function mergeDailyFile(existing: string | null, rows: ReadonlyMap<string, string>): RingFileMerge {
  const lines = ringFileLines(existing ?? `${RING_DAILY_HEADER}\n`);
  const header = ringFileHeader(lines), upgrading = header === RING_DAILY_HEADER_V1;
  if (!upgrading && header !== RING_DAILY_HEADER) return ringStructureRefusal;
  const previousColumns = RING_DAILY_HEADER_V1.split(',').length, updated = new Set<string>();
  let changed = existing === null;
  const eol = firstEol(lines), final = lines.at(-1)!.end, dateOf = (l: { raw: string }) => /^(\d{4}-\d{2}-\d{2}),/.exec(l.raw)?.[1];
  for (const [date, raw] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const at = lines.findIndex((l, i) => i > 0 && dateOf(l) === date);
    if (at >= 0) {
      if (upgrading && lines[at]!.raw.split(',').length !== previousColumns) return ringStructureRefusal;
      const comparable = upgrading ? raw.split(',').slice(0, previousColumns).join(',') : raw;
      if (lines[at]!.raw === comparable) continue;
      lines[at]!.raw = raw; updated.add(date); changed = true; continue;
    }
    const next = lines.findIndex((l, i) => i > 0 && (dateOf(l) ?? '') > date);
    lines.splice(next < 0 ? lines.length : next, 0, { raw, end: eol });
    updated.add(date); changed = true;
  }
  if (!changed) return { ok: true, text: existing!, changed: false };
  if (upgrading) {
    lines[0]!.raw = `${lines[0]!.raw.startsWith('\uFEFF') ? '\uFEFF' : ''}${RING_DAILY_HEADER}`;
    for (const line of lines.slice(1)) if (!updated.has(dateOf(line) ?? '')) {
      if (!dateOf(line) || line.raw.split(',').length !== previousColumns) return ringStructureRefusal;
      line.raw += ','.repeat(RING_DAILY_HEADER.split(',').length - previousColumns);
    }
  }
  const text = joinRingLines(lines, eol, final);
  return { ok: true, text, changed: text !== existing };
}
