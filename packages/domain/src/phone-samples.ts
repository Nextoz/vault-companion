import { PHONE_METRICS, convertPhoneValue, type PhoneKey, type PhoneMetric } from './phone-metrics.ts';
import { DEFAULT_USER_TIME_ZONE } from './time.ts';

export type PhoneSample = { key: PhoneKey; start: number; end: number; value: number; inBed?: boolean };
export type PhoneV2Result = { ok: true; from: Date; sentAt: Date; samples: PhoneSample[] }
  | { ok: false; status: 400 | 422; error: string };
const DAY = 86_400_000;
// Require an explicit offset, real calendar date, and millisecond-or-coarser precision.
function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const date = new Date(value), calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && calendar.toISOString().slice(0, 10) === value.slice(0, 10) ? date : null;
}
export function parsePhoneV2(body: string, now: Date, tz = DEFAULT_USER_TIME_ZONE): PhoneV2Result {
  const fail = (status: 400 | 422, field: string): PhoneV2Result => ({ ok: false, status, error: field });
  if (!Number.isFinite(now.getTime())) return fail(400, 'now');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { return fail(400, 'tz'); }
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return fail(400, 'body'); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'body');
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !['schemaVersion', 'from', 'sentAt', 'samples'].includes(k))) return fail(400, 'body');
  if (obj.schemaVersion !== 2) return fail(400, 'schemaVersion');
  const from = instant(obj.from), sentAt = instant(obj.sentAt);
  if (!from) return fail(400, 'from');
  if (!sentAt || sentAt.getTime() > now.getTime() + 300_000) return fail(400, 'sentAt');
  if (from >= sentAt || sentAt.getTime() - from.getTime() > 8 * DAY) return fail(400, 'from');
  if (typeof obj.samples !== 'string') return fail(400, 'samples');
  const samples: PhoneSample[] = [], seen = new Set<string>();
  const metrics: readonly PhoneMetric[] = PHONE_METRICS;
  const lines = obj.samples.split(/\r\n|\r|\n/);
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const fields = line.split('|'), metric = metrics.find((m) => m.typeName === fields[0]);
    const bad = (status: 400 | 422, field: string) => fail(status, `line ${i + 1} ${metric?.typeName ?? 'type'} ${field}`);
    if (fields.length !== 6) return bad(400, 'fields');
    if (!metric) return bad(400, 'type');
    const [, startText, endText, text, unit, source] = fields as [string, string, string, string, string, string];
    if (/pulseloop/i.test(source)) return bad(422, 'source');
    if (!source.trim() || /[\u0000-\u001f\u007f]/.test(source)) return bad(400, 'source');
    const start = instant(startText), end = instant(endText);
    if (!start) return bad(400, 'start');
    if (!end || end < start) return bad(400, 'end');
    if (start.getTime() < from.getTime() - DAY || end > sentAt) return bad(422, 'start/end');
    if (!Object.hasOwn(metric.units, unit)) return bad(400, 'unit');
    if (metric.category && !text.trim()) return bad(400, 'value');
    const value = metric.category ? 0 : convertPhoneValue(text, metric.units[unit]!, metric.value);
    if (value === null) return bad(400, 'value');
    if (!Number.isFinite(value)) return bad(422, 'value');
    seen.add(metric.key);
    if (metric.category && text !== metric.category) continue;
    samples.push({ key: metric.key as PhoneKey, start: start.getTime(), end: end.getTime(), value,
      ...(metric.category ? { inBed: true } : {}) });
  }
  if (metrics.some((m) => m.required && !seen.has(m.key))) return fail(422, 'samples');
  return { ok: true, from, sentAt, samples };
}
