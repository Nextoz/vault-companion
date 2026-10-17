// Sky monitor (M7c1): pure presentation helpers for the daylight, aurora and moon card — no provider calls, no React.
// The caller owns the fetch (`api.getSky`) and the `unavailable` branch; sun and moon maths live in packages/contracts/src/sun.ts.
import { WEATHER_FALLBACK_LOCATION, daylightChangeSeconds, kpAuroraLevel, moonPhase, sunDay, type KpPoint, type SunDay, type WeatherPoint } from '@vault-companion/contracts';
import { copenhagenDay } from '../../triage.ts';

const TZ = 'Europe/Copenhagen';
const HOUR_MS = 3_600_000;

/** An instant as a local clock time, e.g. "18:10" (en-GB, h23). */
export const clock = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso));

/** Whole minutes as "10 h 11 min"; below an hour just "45 min"; exact hours keep their minutes ("2 h 0 min"). */
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours < 1 ? `${rest} min` : `${hours} h ${rest} min`;
}

/** Today's sun at `location` (null: the fixed Copenhagen fallback) with the daylight change since yesterday. */
export function skySun(
  location: { latitude: number; longitude: number } | null,
  now: Date,
): { date: string; sun: SunDay; changeSeconds: number } {
  const latitude = location?.latitude ?? WEATHER_FALLBACK_LOCATION.latitude;
  const longitude = location?.longitude ?? WEATHER_FALLBACK_LOCATION.longitude;
  const date = copenhagenDay(now.toISOString());
  return { date, sun: sunDay(date, latitude, longitude), changeSeconds: daylightChangeSeconds(date, latitude, longitude) };
}

/** One line for the card body: how much daylight is left in the day and when the sun sets, or the polar special case. */
export function daylightSummary(sun: SunDay): string {
  if (sun.kind !== 'normal') return sun.kind === 'polar-day' ? 'Midnight sun' : 'Polar night';
  return `${formatDuration(sun.daylightMinutes)} daylight · sunset ${clock(sun.sunset)}`;
}

/** Daylight change against yesterday, e.g. "-4 min 50 s per day"; zero is "no change per day". */
export function changeLabel(seconds: number): string {
  if (seconds === 0) return 'no change per day';
  const sign = seconds < 0 ? '-' : '+';
  const total = Math.abs(seconds);
  return `${sign}${Math.floor(total / 60)} min ${total % 60} s per day`;
}

/** "10 h 10 min" until sunset; null on a polar day or once the sun is down. */
export function sunsetIn(sun: SunDay, nowMs: number): string | null {
  if (sun.kind !== 'normal') return null;
  const minutes = (Date.parse(sun.sunset) - nowMs) / 60_000;
  return minutes > 0 ? formatDuration(minutes) : null;
}

/** The driest two-hour window between consecutive hourly points: the card's walk-before-dark hint. */
export interface DaylightWalk {
  start: string;
  end: string;
  /** Both hours' rain added, rounded to one decimal. */
  rainMm: number;
  dry: boolean;
}

/**
 * The pair of consecutive hourly points whose two hours sit inside daylight, start no earlier than now, and carry the
 * least rain (ties: the earliest). A null rain hour breaks every window over it — gaps are never guessed. Null if none.
 */
export function bestDaylightWalk(points: readonly WeatherPoint[], sun: SunDay, nowMs: number): DaylightWalk | null {
  if (sun.kind !== 'normal') return null;
  const earliest = Math.max(nowMs, Date.parse(sun.sunrise));
  const sunsetMs = Date.parse(sun.sunset);
  let best: DaylightWalk | null = null;
  let bestRain = Infinity;
  let previous: WeatherPoint | null = null;
  for (const second of points) {
    const first = previous;
    previous = second;
    if (first === null) continue;
    const startMs = Date.parse(first.time);
    if (Date.parse(second.time) - startMs !== HOUR_MS) continue;
    const endMs = startMs + 2 * HOUR_MS;
    if (startMs < earliest || endMs > sunsetMs) continue;
    if (first.rainMm === null || second.rainMm === null) continue;
    const rain = first.rainMm + second.rainMm;
    if (rain >= bestRain) continue;
    bestRain = rain;
    best = { start: first.time, end: new Date(endMs).toISOString(), rainMm: Math.round(rain * 10) / 10, dry: rain <= 0.1 };
  }
  return best;
}

/** The current Kp value and its aurora outlook at Copenhagen's latitude, or null when the provider skips now. */
export function kpLabel(point: KpPoint | null): { value: string; level: string } | null {
  if (point === null) return null;
  return { value: `Kp ${Math.round(point.kp)}`, level: `aurora · ${kpAuroraLevel(point.kp)}` };
}

/** The moon's illuminated share, e.g. "31 %", and whether it is growing. */
export function moonLabel(now: Date): { value: string; sub: string } {
  const moon = moonPhase(now);
  return { value: `${Math.round(moon.illumination * 100)} %`, sub: moon.waxing ? 'moon waxing' : 'moon waning' };
}
