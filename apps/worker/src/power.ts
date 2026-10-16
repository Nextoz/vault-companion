// Pure parsing and projection for the power monitor (M4). No fetch here: power-provider.ts owns the network.
// Energi Data Service time columns carry no zone suffix; the *UTC columns are parsed as UTC and the Danish local
// columns are ignored (they repeat 02:xx on the autumn DST day).
import { POWER_REASON_NOTES, POWER_WINDOW_HOURS, type PowerCo2, type PowerDay, type PowerHour, type PowerResponse, type PowerWindow } from '@vault-companion/contracts';
import { userDate } from '@vault-companion/domain';

export interface PriceRow {
  /** ISO instant with `Z`. */
  readonly timeUtc: string;
  /** Provider nulls stay null: that quarter is left out of its hour's mean. */
  readonly dkkPerMwh: number | null;
}

export interface Co2Row {
  readonly timeUtc: string;
  readonly gPerKwh: number;
}

const HOUR_MS = 3_600_000;
const QUARTER_MS = 15 * 60_000;
/** A CO2 row older than this is not shown as "now". */
const CO2_MAX_AGE_MS = 30 * 60_000;
const UTC_COLUMN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

function utcMs(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC_COLUMN.test(value)) return null;
  const ms = Date.parse(`${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function records(body: unknown): unknown[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rows = (body as Record<string, unknown>).records;
  return Array.isArray(rows) ? rows : null;
}

/** Strict reader for `DayAheadPrices` (DK2 only). Any unexpected row refuses the whole body (null). */
export function parsePriceBody(body: unknown): PriceRow[] | null {
  const rows = records(body);
  if (!rows) return null;
  const seen = new Set<number>();
  const out: PriceRow[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) return null;
    const r = row as Record<string, unknown>;
    if (r.PriceArea !== 'DK2') return null;
    const ms = utcMs(r.TimeUTC);
    if (ms === null || ms % QUARTER_MS !== 0 || seen.has(ms)) return null;
    seen.add(ms);
    const price = r.DayAheadPriceDKK;
    if (price !== null && (typeof price !== 'number' || !Number.isFinite(price))) return null;
    out.push({ timeUtc: new Date(ms).toISOString(), dkkPerMwh: price });
  }
  return out;
}

/** Strict reader for `CO2Emis` / `CO2EmisProg` (DK2, g/kWh). */
export function parseCo2Body(body: unknown): Co2Row[] | null {
  const rows = records(body);
  if (!rows) return null;
  const out: Co2Row[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) return null;
    const r = row as Record<string, unknown>;
    if (r.PriceArea !== 'DK2') return null;
    const ms = utcMs(r.Minutes5UTC);
    const value = r.CO2Emission;
    if (ms === null || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    out.push({ timeUtc: new Date(ms).toISOString(), gPerKwh: value });
  }
  return out;
}

function hourLabel(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

interface Hour extends PowerHour {
  readonly ms: number;
  readonly day: string;
}

function windowLabel(startMs: number, endMs: number, timeZone: string): string {
  const end = hourLabel(endMs, timeZone);
  // An end exactly at local midnight closes the day: written 24, not 00.
  const endsAtMidnight = end === '00' && userDate(new Date(endMs), timeZone) !== userDate(new Date(endMs - 1), timeZone);
  return `${hourLabel(startMs, timeZone)}-${endsAtMidnight ? '24' : end}`;
}

/** Lowest-mean run of POWER_WINDOW_HOURS consecutive hours (each next start = previous + 1 h); ties keep the earliest. */
function cheapest(hours: readonly Hour[], timeZone: string): PowerWindow | null {
  let best: { from: number; mean: number } | null = null;
  for (let i = 0; i + POWER_WINDOW_HOURS <= hours.length; i++) {
    const run = hours.slice(i, i + POWER_WINDOW_HOURS);
    if (run.some((h, k) => k > 0 && h.ms !== run[k - 1]!.ms + HOUR_MS)) continue;
    const mean = run.reduce((sum, h) => sum + h.krPerKwh, 0) / run.length;
    if (best === null || mean < best.mean) best = { from: i, mean };
  }
  if (best === null) return null;
  const first = hours[best.from]!;
  const endMs = first.ms + POWER_WINDOW_HOURS * HOUR_MS;
  return {
    day: first.day,
    start: new Date(first.ms).toISOString(),
    end: new Date(endMs).toISOString(),
    label: windowLabel(first.ms, endMs, timeZone),
    averageKrPerKwh: round4(best.mean),
  };
}

const publicHour = (h: Hour): PowerHour => ({ start: h.start, label: h.label, krPerKwh: h.krPerKwh, quarters: h.quarters });

function powerDay(day: string, hours: readonly Hour[], timeZone: string): PowerDay {
  if (hours.length === 0) return { status: 'not-published', day };
  const prices = hours.map((h) => h.krPerKwh);
  return {
    status: 'ok',
    day,
    hours: hours.map(publicHour),
    averageKrPerKwh: round4(prices.reduce((a, b) => a + b, 0) / prices.length),
    minKrPerKwh: Math.min(...prices),
    maxKrPerKwh: Math.max(...prices),
    cheapestWindow: cheapest(hours, timeZone),
  };
}

function latest(rows: readonly Co2Row[] | null, nowMs: number): Co2Row | null {
  let best: Co2Row | null = null;
  for (const row of rows ?? []) {
    const at = Date.parse(row.timeUtc);
    if (at > nowMs || nowMs - at > CO2_MAX_AGE_MS) continue;
    if (best === null || at > Date.parse(best.timeUtc)) best = row;
  }
  return best;
}

function co2Now(co2: readonly Co2Row[] | null, co2Prog: readonly Co2Row[] | null, nowMs: number): PowerCo2 | null {
  const measured = latest(co2, nowMs);
  if (measured) return { at: measured.timeUtc, gPerKwh: measured.gPerKwh, kind: 'measured' };
  const forecast = latest(co2Prog, nowMs);
  return forecast ? { at: forecast.timeUtc, gPerKwh: forecast.gPerKwh, kind: 'forecast' } : null;
}

export function projectPower(input: {
  prices: readonly PriceRow[];
  co2: readonly Co2Row[] | null;
  co2Prog: readonly Co2Row[] | null;
  now: Date;
  fetchedAt: string;
  timeZone: string;
}): PowerResponse {
  const { timeZone, now } = input;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const byHour = new Map<number, number[]>();
  for (const row of input.prices) {
    if (row.dkkPerMwh === null) continue;
    const ms = Date.parse(row.timeUtc);
    const hourMs = ms - (ms % HOUR_MS);
    const list = byHour.get(hourMs) ?? [];
    list.push(row.dkkPerMwh);
    byHour.set(hourMs, list);
  }
  const hours: Hour[] = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, values]) => ({
      ms,
      day: userDate(new Date(ms), timeZone),
      start: new Date(ms).toISOString(),
      label: hourLabel(ms, timeZone),
      krPerKwh: round4(values.reduce((a, b) => a + b, 0) / values.length / 1000),
      quarters: values.length,
    }));
  const todayDate = userDate(now, timeZone);
  const tomorrowDate = nextDate(todayDate);
  const todayHours = hours.filter((h) => h.day === todayDate);
  if (todayHours.length === 0) return { status: 'unavailable', now: nowIso, reason: 'empty', note: POWER_REASON_NOTES.empty };
  const tomorrowHours = hours.filter((h) => h.day === tomorrowDate);
  const current = todayHours.find((h) => h.ms <= nowMs && nowMs < h.ms + HOUR_MS);
  return {
    status: 'ok',
    now: nowIso,
    fetchedAt: input.fetchedAt,
    area: 'DK2',
    today: powerDay(todayDate, todayHours, timeZone),
    tomorrow: powerDay(tomorrowDate, tomorrowHours, timeZone),
    nowHour: current ? publicHour(current) : null,
    upcomingWindow: cheapest([...todayHours, ...tomorrowHours].filter((h) => h.ms + HOUR_MS > nowMs), timeZone),
    co2: co2Now(input.co2, input.co2Prog, nowMs),
  };
}
