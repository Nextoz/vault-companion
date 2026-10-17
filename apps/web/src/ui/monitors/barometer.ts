// Barometer monitor (markets screen): pure presentation helpers over the Barometer contract — no provider calls, no
// React, no vault text. The caller owns the fetch (`api.getBarometer`) and the `unavailable` branch; every helper
// below takes an `ok` response.
import { BAROMETER_MAX_HPA, BAROMETER_MIN_HPA, type BarometerResponse, type BarometerTrend } from '@vault-companion/contracts';

/** The `ok` arm of `BarometerResponse`: a reading that exists, with its source, trend and zone. */
export type BarometerOk = Extract<BarometerResponse, { status: 'ok' }>;

/** Arrow for the summary line: rising ↑, falling ↓, steady →; empty when there is no history. */
export function trendArrow(trend: BarometerTrend | null): '↑' | '↓' | '→' | '' {
  if (trend === 'rising') return '↑';
  if (trend === 'falling') return '↓';
  if (trend === 'steady') return '→';
  return '';
}

/** Size of the three-hour pressure change with one decimal, e.g. "1.3"; null when there is no history. */
export function changeText(r: BarometerOk): string | null {
  return r.changeHpa === null ? null : Math.abs(r.changeHpa).toFixed(1);
}

/** One line for the card body, e.g. "1020.2 hPa · ↑ 1.3 in 3 h · Fair"; no history omits the trend clause and a
 * model source appends " · model". */
export function baroSummary(r: BarometerOk): string {
  const parts = [`${r.hPa.toFixed(1)} hPa`];
  const change = changeText(r);
  if (change !== null && r.trend !== null) parts.push(`${trendArrow(r.trend)} ${change} in 3 h`);
  parts.push(r.zone);
  if (r.source === 'model') parts.push('model');
  return parts.join(' · ');
}

/** Caption under the dial, e.g. "hPa · rising 1.3 in 3 h · Fair"; steady is the bare word, no history drops the
 * trend clause. */
export function baroCaption(r: BarometerOk): string {
  const parts = ['hPa'];
  const change = changeText(r);
  if (change !== null && r.trend !== null) {
    parts.push(r.trend === 'steady' ? 'steady' : `${r.trend} ${change} in 3 h`);
  }
  parts.push(r.zone);
  return parts.join(' · ');
}

/** Spoken label for the dial, e.g. "Barometer 1020.2 hPa, rising 1.3 hPa in 3 hours, Fair"; steady is the bare
 * word, no history drops the clause and a model source ends with ", model estimate". */
export function baroAria(r: BarometerOk): string {
  const parts = [`Barometer ${r.hPa.toFixed(1)} hPa`];
  const change = changeText(r);
  if (change !== null && r.trend !== null) {
    parts.push(r.trend === 'steady' ? 'steady' : `${r.trend} ${change} hPa in 3 hours`);
  }
  parts.push(r.zone);
  if (r.source === 'model') parts.push('model estimate');
  return parts.join(', ');
}

/** The observation time as a local "HH:mm" clock time (en-GB, h23), e.g. "16:05". */
export function obsTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));
}

/** How old a fetch may be before the card shows it as stale (a failed refresh reuses the previous reading). */
const BAROMETER_STALE_MS = 30 * 60_000;

/** True only for an `ok` response whose rows were fetched more than 30 minutes before `nowMs`. */
export function baroStale(r: BarometerOk, nowMs: number): boolean {
  return nowMs - Date.parse(r.fetchedAt) > BAROMETER_STALE_MS;
}

/** Dial angle in degrees clockwise from straight up: 950 hPa sits at -135, 1050 at +135, clamped at both ends. */
export function dialAngle(hPa: number): number {
  const clamped = Math.min(Math.max(hPa, BAROMETER_MIN_HPA), BAROMETER_MAX_HPA);
  return -135 + (clamped - BAROMETER_MIN_HPA) * 2.7;
}

/** Point at radius `r` from (cx, cy) at `angleDeg` clockwise from straight up, rounded to 2 decimals. */
export function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  return [round2(cx + r * Math.sin(rad)), round2(cy - r * Math.cos(rad))];
}

/** SVG arc of radius `r` from angle `a1` to `a2` (degrees, clockwise); no barometer zone exceeds 180°, so the
 * large-arc flag is always 0. */
export function arcPath(cx: number, cy: number, r: number, a1: number, a2: number): string {
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a2);
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
}
