import { bodyShape, parseIso } from './health-ingest.ts';
import { RING_METRICS, RING_SCHEMAS, ringValueValid, type RingKey } from './ring-metrics.ts';
import { DEFAULT_USER_TIME_ZONE } from './time.ts';

export type RingSlot = { instant: number; values: Record<RingKey, number | null> };
type ParseResult = { ok: true; version: number; slots: RingSlot[] } | { ok: false; status: 400 | 422; error: string };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// Building an Intl formatter costs ~100 us; a month file has ~3,000 slots, so reuse one per zone.
const formatters = new Map<string, Intl.DateTimeFormat>();
/** The zone's UTC offset in minutes at `instant`, from Intl (~5 us a call). */
function intlOffset(instant: number, tz: string): number {
  const format = formatters.get(tz) ?? new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  formatters.set(tz, format);
  const parts = format.formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === name)!.value;
  const local = Date.parse(`${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}Z`);
  return Math.round((local - Math.floor(instant / 1000) * 1000) / 60000);
}
// Workers Free allows 10 ms CPU a request and a ring send touches thousands of slots, so Intl runs at most twice per
// UTC day: an offset changes at most once a day, so equal offsets at both ends of a UTC day hold for all of it. A day
// with a transition (two a year) uses Intl per call. Output is identical (ring-slots.test.ts compares every slot of
// two years, DST included, with the Intl path).
const DAY = 86_400_000, dayOffsets = new Map<string, number | null>();
function offsetMinutes(instant: number, tz: string): number {
  const day = Math.floor(instant / DAY), key = `${tz}|${day}`;
  let cached = dayOffsets.get(key);
  if (cached === undefined) {
    const start = intlOffset(day * DAY, tz);
    cached = start === intlOffset(day * DAY + DAY - 1, tz) ? start : null;
    if (dayOffsets.size > 4096) dayOffsets.clear();
    dayOffsets.set(key, cached);
  }
  return cached ?? intlOffset(instant, tz);
}
export function canonicalSlotStart(instant: number, tz = DEFAULT_USER_TIME_ZONE): string {
  const offset = offsetMinutes(instant, tz), abs = Math.abs(offset);
  const local = new Date(Math.floor(instant / 60_000) * 60_000 + offset * 60_000).toISOString().slice(0, 16);
  return `${local}:00${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
/** The original Intl-only formatting, verbatim, kept as the test oracle for `canonicalSlotStart`. */
export function canonicalSlotStartIntl(instant: number, tz = DEFAULT_USER_TIME_ZONE): string {
  const format = formatters.get(tz) ?? new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  formatters.set(tz, format);
  const parts = format.formatToParts(instant);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === name)!.value;
  const local = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00`;
  const offset = Math.round((Date.parse(`${local.slice(0, -2)}${part('second')}Z`) - Math.floor(instant / 1000) * 1000) / 60000);
  const abs = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
export const slotMonth = (instant: number, tz = DEFAULT_USER_TIME_ZONE): string => canonicalSlotStart(instant, tz).slice(0, 7);
export function splitByMonth(slots: readonly RingSlot[], tz = DEFAULT_USER_TIME_ZONE): Map<string, RingSlot[]> {
  const months = new Map<string, RingSlot[]>();
  for (const slot of [...slots].sort((a, b) => a.instant - b.instant)) {
    const month = slotMonth(slot.instant, tz);
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(slot);
  }
  return months;
}
export function parseRingPayload(body: string, now: Date, timeZone = DEFAULT_USER_TIME_ZONE): ParseResult {
  const fail = (status: 400 | 422, key: string): ParseResult => ({ ok: false, status, error: `${key} (${bodyShape(body)})` });
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return fail(400, 'body'); }
  if (!object(raw)) return fail(400, 'body');
  for (const key of Object.keys(raw)) if (!['schema', 'device', 'generatedAt', 'slots'].includes(key)) return fail(400, key);
  const version = typeof raw.schema === 'string' && Object.hasOwn(RING_SCHEMAS, raw.schema) ? RING_SCHEMAS[raw.schema] : undefined;
  if (version === undefined) return fail(400, 'schema');
  if (typeof raw.device !== 'string' || raw.device.trim().length === 0 || raw.device.length > 64) return fail(400, 'device');
  const generated = parseIso(raw.generatedAt)?.getTime();
  if (generated === undefined || generated > now.getTime() + 300000) return fail(400, 'generatedAt');
  if (!Array.isArray(raw.slots)) return fail(400, 'slots');
  const metrics = RING_METRICS.filter((m) => m.since <= version);
  const keys = new Set(['start', ...metrics.map((m) => m.key)]);
  const slots: RingSlot[] = [], seen = new Set<number>();
  for (const [i, slot] of raw.slots.entries()) {
    const bad = (status: 400 | 422, key: string) => fail(status, `slot ${i} ${key}`);
    if (!object(slot)) return bad(400, 'start');
    for (const key of keys) if (!Object.hasOwn(slot, key)) return bad(400, key);
    for (const key of Object.keys(slot)) if (!keys.has(key)) return bad(400, key);
    const instant = parseIso(slot.start)?.getTime();
    if (instant === undefined) return bad(400, 'start');
    if (typeof slot.start !== 'string' || !/T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/.test(slot.start) || Number(canonicalSlotStart(instant, timeZone).slice(14, 16)) % 15 !== 0) return bad(422, 'start');
    if (instant < generated - 8 * 86400000 || instant > generated || seen.has(instant)) return bad(422, 'start');
    seen.add(instant);
    const values = {} as RingSlot['values'];
    const sums = new Map<string, number>();
    for (const m of metrics) {
      const v = slot[m.key];
      if (v !== null && (typeof v !== 'number' || !ringValueValid(m.value, v))) return bad(400, m.key);
      values[m.key] = v as number | null;
      if (m.sumGroup) {
        const sum = (sums.get(m.sumGroup.id) ?? 0) + (values[m.key] ?? 0);
        if (sum > m.sumGroup.max) return bad(422, m.key);
        sums.set(m.sumGroup.id, sum);
      }
    }
    if (Object.values(values).every((v) => v === null)) return bad(422, 'start');
    slots.push({ instant, values });
  }
  return { ok: true, version, slots: slots.sort((a, b) => a.instant - b.instant) };
}
