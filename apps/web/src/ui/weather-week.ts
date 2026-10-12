// Weather week overview + day meteogram math (WX1b). Pure presentation helpers over the shared `WeatherProjection`
// week days: no provider calls, no vault text, no domain import. Provider nulls stay gaps and are never interpolated.
import { WEATHER_TIME_ZONE, type WeatherModelSeries, type WeatherRunWindow, type WeatherWeekDay } from '@vault-companion/contracts';
import type { IconName } from './icons.ts';

export interface Scale {
  readonly min: number;
  readonly max: number;
}

const HOUR_MS = 3_600_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const clock = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

const localParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: WEATHER_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

function localDateHour(iso: string): { date: string; hour: number } {
  const parts = localParts.formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** The Copenhagen `YYYY-MM-DD` date of an instant, e.g. the projection's server `now`. */
export const localDate = (iso: string): string => localDateHour(iso).date;

/** A week row's day name: "Today" for the server's current Copenhagen date, else "Thu". */
export function rowDayLabel(day: string, today: string | null): string {
  return day === today ? 'Today' : shortDayLabel(day);
}

/** A `YYYY-MM-DD` Copenhagen date, labelled "Thu 15 Oct" (UTC date math on the plain date string). */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return `${WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** A `YYYY-MM-DD` Copenhagen date, labelled "Thu" only. */
export function shortDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : WEEKDAYS[(date.getUTCDay() + 6) % 7]!;
}

/** A `YYYY-MM-DD` Copenhagen date, labelled "30 Sep" without the weekday. */
export function dayDateLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** Shared low/high scale across every week day, so one row's bar is comparable with the next. */
export function weekScale(days: readonly WeatherWeekDay[]): Scale {
  const values = days.flatMap((day) => [day.lowTemperatureC, day.highTemperatureC]).filter((v): v is number => v !== null);
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? { min: min - 1, max: max + 1 } : { min, max };
}

/** A value's 0-100 position on a scale; a flat scale centres its single value instead of dividing by zero. */
export function scalePercent(value: number, scale: Scale): number {
  const span = scale.max - scale.min;
  if (!(span > 0)) return 50;
  return ((value - scale.min) / span) * 100;
}

/** The day's low-to-high bar as 0-100 percentages on the shared scale, or null when the day has no range. */
export function weekBar(day: WeatherWeekDay, scale: Scale): { left: number; width: number } | null {
  if (day.lowTemperatureC === null || day.highTemperatureC === null) return null;
  const a = scalePercent(day.lowTemperatureC, scale);
  const b = scalePercent(day.highTemperatureC, scale);
  const left = Math.max(0, Math.min(a, b));
  const right = Math.min(100, Math.max(a, b));
  return { left, width: Math.max(0, right - left) };
}

/** Day range as text: "4-9°" rounded, or "no range" when either bound is a provider gap. */
export function weekBarLabel(day: WeatherWeekDay): string {
  if (day.lowTemperatureC === null || day.highTemperatureC === null) return 'no range';
  return `${Math.round(day.lowTemperatureC)}-${Math.round(day.highTemperatureC)}°`;
}

export type RainMode = 'chance' | 'amount';

/** One rain unit for the whole week column: chance only when every day has one (ECMWF covers the week), else mm. */
export function weekRainMode(days: readonly WeatherWeekDay[]): RainMode {
  return days.length > 0 && days.every((day) => day.precipitationProbabilityPct !== null) ? 'chance' : 'amount';
}

/** Rain as the week's unit; without a mode, chance when the provider gives one (ECMWF only), else the total. */
export function rainLabel(day: WeatherWeekDay, mode?: RainMode): string {
  if (mode !== 'amount' && day.precipitationProbabilityPct !== null) return `${Math.round(day.precipitationProbabilityPct)}%`;
  if (day.rainMm === null) return '—';
  return day.rainMm === 0 ? 'dry' : `${day.rainMm.toFixed(1)} mm`;
}

/** The one small line under the rows that replaces per-row chips: which bars are single-model, which days partial. */
export function weekFootnote(days: readonly WeatherWeekDay[], today: string | null): string | null {
  const notes: string[] = [];
  if (days.some((day) => day.models === 1)) notes.push('Faded bar: one model only');
  const partial = days.filter((day) => day.partial && day.day !== today).map((day) => shortDayLabel(day.day));
  if (partial.length > 0) notes.push(`${partial.join(', ')}: partial day`);
  return notes.length > 0 ? notes.join(' · ') : null;
}

/** The honest per-day model count: a day beyond the DMI horizon is labelled, never padded to two. */
export function modelCountLabel(day: WeatherWeekDay): string {
  return day.models === 1 ? '1 model' : '2 models';
}

const windowRain = (day: WeatherWeekDay): number => day.runWindow?.rainMm ?? Infinity;

/** The best day to run: the complete day whose shared run window has the least rain, earliest on a tie. */
export function bestRunDay(days: readonly WeatherWeekDay[]): WeatherWeekDay | null {
  const withWindow = days.filter((day) => day.runWindow !== null);
  if (withWindow.length === 0) return null;
  const complete = withWindow.filter((day) => !day.partial);
  const pool = complete.length > 0 ? complete : withWindow;
  return pool.reduce((best, day) => (windowRain(day) < windowRain(best) ? day : best));
}

function windowClock(window: WeatherRunWindow): string {
  const start = localDateHour(window.start);
  const end = localDateHour(window.end);
  return `${clock(start.hour)}-${clock(end.hour)}`;
}

const windowRainText = (window: WeatherRunWindow): string =>
  (window.rainMm === null ? 'rain unknown' : window.rainMm === 0 ? 'dry' : `${window.rainMm.toFixed(1)} mm rain`);

/** One line naming the best day and its shared run window, or null when no day has one. */
export function bestRunSummary(days: readonly WeatherWeekDay[]): string | null {
  const day = bestRunDay(days);
  if (!day || !day.runWindow) return null;
  return `Best day to run: ${dayLabel(day.day)} · ${windowClock(day.runWindow)} · ${windowRainText(day.runWindow)}`;
}

/** The meteogram's run line: "Best run 08:00-10:00 · 0.3 mm rain · 14-15° · wind 4-5 m/s". */
export function dayRunSummary(window: WeatherRunWindow | null): string {
  if (!window) return 'No two-hour run window this day';
  const temp = `${Math.round(window.temperatureRangeC.min)}-${Math.round(window.temperatureRangeC.max)}°`;
  const wind = `wind ${Math.round(window.windRangeMs.min)}-${Math.round(window.windRangeMs.max)} m/s`;
  return `Best run ${windowClock(window)} · ${windowRainText(window)} · ${temp} · ${wind}`;
}

export interface DayHour {
  readonly hour: number;
  readonly time: string;
  readonly temperatureC: number | null;
  readonly rainMm: number | null;
  readonly windMs: number | null;
  readonly windDirectionDeg: number | null;
  readonly precipitationProbabilityPct: number | null;
  readonly weatherCode: number | null;
}

/** Keep the first known value: a later model never overwrites an earlier one, provider nulls stay gaps. */
function merge(frame: DayHour | undefined, next: DayHour): DayHour {
  if (!frame) return next;
  return {
    hour: frame.hour,
    time: frame.time,
    temperatureC: frame.temperatureC ?? next.temperatureC,
    rainMm: frame.rainMm ?? next.rainMm,
    windMs: frame.windMs ?? next.windMs,
    windDirectionDeg: frame.windDirectionDeg ?? next.windDirectionDeg,
    precipitationProbabilityPct: frame.precipitationProbabilityPct ?? next.precipitationProbabilityPct,
    weatherCode: frame.weatherCode ?? next.weatherCode,
  };
}

const toDayHour = (hour: number, point: WeatherModelSeries['points'][number]): DayHour => ({
  hour,
  time: point.time,
  temperatureC: point.temperatureC,
  rainMm: point.rainMm,
  windMs: point.windMs,
  windDirectionDeg: point.windDirectionDeg,
  precipitationProbabilityPct: point.precipitationProbabilityPct,
  weatherCode: point.weatherCode,
});

/** One model's hours for a Copenhagen calendar day (first value wins if a DST fold repeats an hour). */
export function modelDayHours(series: WeatherModelSeries, day: string): DayHour[] {
  const hours = new Map<number, DayHour>();
  for (const point of series.points) {
    const local = localDateHour(point.time);
    if (local.date !== day) continue;
    hours.set(local.hour, merge(hours.get(local.hour), toDayHour(local.hour, point)));
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour);
}

/** The merged day across the available models, first model winning each value (mirrors the domain week day). */
export function dayHours(models: readonly WeatherModelSeries[], day: string): DayHour[] {
  const hours = new Map<number, DayHour>();
  for (const series of models) {
    for (const hour of modelDayHours(series, day)) hours.set(hour.hour, merge(hours.get(hour.hour), hour));
  }
  return [...hours.values()].sort((a, b) => a.hour - b.hour);
}

/** Temperature scale across every model's hours for the day. */
export function dayScale(hoursByModel: readonly (readonly DayHour[])[]): Scale {
  const values = hoursByModel.flatMap((hours) => hours.map((hour) => hour.temperatureC)).filter((v): v is number => v !== null);
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? { min: min - 1, max: max + 1 } : { min, max };
}

/** One rain bar's height as 0-100 of the day's wettest known hour; a null or dry hour is a zero bar. */
export function rainBar(hour: DayHour, maxRain: number): number {
  if (hour.rainMm === null || !(maxRain > 0)) return 0;
  return Math.min(100, (hour.rainMm / maxRain) * 100);
}

/** The local hours a run window covers (start inclusive), for shading the band on the meteogram. */
export function runWindowHours(window: WeatherRunWindow | null): number[] {
  if (!window) return [];
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const hours: number[] = [];
  for (let t = start; t < end; t += HOUR_MS) hours.push(localDateHour(new Date(t).toISOString()).hour);
  return [...new Set(hours)].sort((a, b) => a - b);
}

/** One-line plain summary of the day's rain: "Rain from 15:00", "Rain all day", "No rain through the day". */
export function rainSummary(hours: readonly DayHour[]): string {
  const known = hours.filter((hour) => hour.rainMm !== null);
  if (known.length === 0) return 'Rain data unavailable';
  const rainy = known.filter((hour) => (hour.rainMm as number) > 0);
  if (rainy.length === 0) return 'No rain through the day';
  if (rainy.length === known.length) return 'Rain all day';
  return `Rain from ${clock(rainy[0]!.hour)}`;
}

/** WMO weather code -> icon name for a week row (icons.ts). No provider or note text is rendered as an icon. */
export function weatherGlyph(code: number | null): IconName {
  if (code === null) return 'dot';
  if (code === 0) return 'sun';
  if (code <= 2) return 'part-cloud';
  if (code === 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain';
  if (code <= 86) return 'snow';
  return 'storm';
}

/** Short accessible description of a WMO weather code for a week row's label. */
export function weatherCodeLabel(code: number | null): string {
  if (code === null) return 'No forecast';
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}
