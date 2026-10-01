// Weather projection (ADR-0033 W1). Reads two fixed public forecast models through an injected reader and turns them
// into one honest shared read model. No HTTP, no identity, no private location; nothing here touches the vault or GitHub.
import {
  roundWeatherCoordinate,
  WEATHER_ATTRIBUTION,
  WEATHER_FALLBACK_LOCATION,
  WEATHER_FORECAST_HOURS,
  WEATHER_MODELS,
  WEATHER_MODEL_PLAN,
  WEATHER_TERMS_URL,
  WEATHER_TIME_ZONE,
  type WeatherAgreement,
  type WeatherCoverage,
  type WeatherFailureReason,
  type WeatherLocation,
  type WeatherLocationRequest,
  type WeatherMinMax,
  type WeatherModel,
  type WeatherModelSeries,
  type WeatherPartialError,
  type WeatherPoint,
  type WeatherResponse,
  type WeatherRunWindow,
} from '@vault-companion/contracts';
import { userDate } from './time.ts';

export type WeatherModelOutcome =
  | { readonly status: 'ok'; readonly series: WeatherModelSeries; readonly fresh: true }
  | { readonly status: 'ok'; readonly series: WeatherModelSeries; readonly fresh: false }
  | { readonly status: 'unavailable'; readonly reason: WeatherFailureReason };

export interface WeatherModelReader {
  forecast(location: WeatherLocation, model: WeatherModel): Promise<WeatherModelOutcome>;
}

export interface WeatherServiceDeps {
  readonly reader: WeatherModelReader;
  readonly now: () => Date;
  readonly timeZone?: string;
}

/** Rounds a location before any reader/cache call. The label is never a saved or reverse-geocoded address. */
export function normalizeWeatherLocation(location: WeatherLocation): WeatherLocation {
  return {
    ...location,
    latitude: roundWeatherCoordinate(location.latitude),
    longitude: roundWeatherCoordinate(location.longitude),
    timeZone: WEATHER_TIME_ZONE,
  };
}

/** Device coordinates become a rounded, labelled public location. The client sends only explicit foreground consent. */
export function deviceWeatherLocation(request: WeatherLocationRequest): WeatherLocation {
  return {
    label: 'Device location (rounded ~1 km)',
    latitude: roundWeatherCoordinate(request.latitude),
    longitude: roundWeatherCoordinate(request.longitude),
    precision: 'device-rounded',
    timeZone: WEATHER_TIME_ZONE,
  };
}

interface LocalPoint {
  readonly date: string;
  readonly hour: number;
}

const round4 = (value: number): number => Number(value.toFixed(4));

function localPoint(iso: string, timeZone: string): LocalPoint {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  };
}

function minMax(values: readonly number[]): WeatherMinMax | null {
  if (values.length === 0) return null;
  return { min: round4(Math.min(...values)), max: round4(Math.max(...values)) };
}

function overlap(a: WeatherModelSeries, b: WeatherModelSeries): boolean {
  const times = new Set(a.points.map((p) => p.time));
  return b.points.some((p) => times.has(p.time));
}

export function agreementFor(models: readonly WeatherModelSeries[]): WeatherAgreement {
  if (models.length === 0) return 'unavailable';
  if (models.length >= 2 && overlap(models[0]!, models[1]!)) return 'two-models';
  return 'single-model';
}

function coverageFor(models: readonly WeatherModelSeries[]): WeatherCoverage {
  const primary = models[0] ?? null;
  const comparison = models[1] ?? null;
  return {
    expectedPoints: WEATHER_FORECAST_HOURS,
    primaryReturned: primary?.points.length ?? 0,
    comparisonReturned: comparison?.points.length ?? 0,
    primaryMissingIntervals: primary?.missingIntervals ?? 0,
    comparisonMissingIntervals: comparison?.missingIntervals ?? 0,
  };
}

interface Candidate {
  readonly start: string;
  readonly end: string;
  readonly score: number;
  readonly totals: readonly number[];
  readonly models: readonly WeatherModel[];
  readonly points: readonly WeatherPoint[];
}

/**
 * Chooses the lowest-rain contiguous two-hour window inside Copenhagen daytime 08:00-20:00. Each candidate uses two
 * consecutive hourly buckets; model totals are averaged only to rank candidates, while the returned values are actual
 * per-model values (lowest total plus min/max spread). No candidate is a dry-weather or daylight guarantee.
 */
export function chooseRunWindow(models: readonly WeatherModelSeries[], day: string, timeZone: string): WeatherRunWindow | null {
  const byTime = models.map((series) => new Map(series.points.map((point) => [Date.parse(point.time), point] as const)));
  const times = [...new Set(models.flatMap((series) => series.points.map((p) => Date.parse(p.time))))].sort((a, b) => a - b);
  let best: Candidate | null = null;
  for (let i = 0; i < times.length - 1; i++) {
    const t0 = times[i]!;
    const t1 = times[i + 1]!;
    if (t1 - t0 !== 3_600_000) continue; // an hourly bucket is missing: the gap stays a gap, never bridged
    const startLocal = localPoint(new Date(t0).toISOString(), timeZone);
    const endLocal = localPoint(new Date(t1).toISOString(), timeZone);
    if (startLocal.date !== day || endLocal.date !== day) continue;
    if (startLocal.hour < 8 || startLocal.hour > 18) continue;
    if (endLocal.hour !== startLocal.hour + 1) continue; // DST/skew: do not pretend a two-hour daytime window

    const totals: number[] = [];
    const contributing: WeatherModel[] = [];
    const points: WeatherPoint[] = [];
    for (let m = 0; m < models.length; m++) {
      const first = byTime[m]!.get(t0);
      const second = byTime[m]!.get(t1);
      if (!first || !second || first.rainMm === null || second.rainMm === null) continue;
      totals.push(round4(first.rainMm + second.rainMm));
      contributing.push(models[m]!.model);
      points.push(first, second);
    }
    if (totals.length === 0) continue;
    const score = totals.reduce((sum, value) => sum + value, 0) / totals.length;
    if (!best || score < best.score || (score === best.score && t0 < Date.parse(best.start))) {
      best = { start: new Date(t0).toISOString(), end: new Date(t1 + 3_600_000).toISOString(), score, totals, models: contributing, points };
    }
  }
  if (!best) return null;
  const temperature = minMax(best.points.map((p) => p.temperatureC).filter((v): v is number => v !== null));
  const wind = minMax(best.points.map((p) => p.windMs).filter((v): v is number => v !== null));
  if (!temperature || !wind) return null;
  const rainRange = minMax(best.totals);
  if (!rainRange) return null;
  return {
    day,
    daytimeStart: '08:00',
    daytimeEnd: '20:00',
    start: best.start,
    end: best.end,
    agreement: best.models.length >= 2 ? 'two-models' : 'single-model',
    models: [...best.models],
    rainMm: Math.min(...best.totals),
    rainRangeMm: rainRange,
    temperatureRangeC: temperature,
    windRangeMs: wind,
    note: best.models.length >= 2
      ? 'Lowest-rain two-hour window inside Copenhagen daytime 08:00-20:00. Not a guarantee of dry or daylight weather.'
      : 'Lowest-rain two-hour daytime window from the single model that covers it. Not a guarantee of dry or daylight weather.',
  };
}

function unavailableReason(primary: WeatherModelOutcome | undefined, comparison: WeatherModelOutcome | undefined): WeatherFailureReason {
  if (primary?.status === 'unavailable') return primary.reason;
  if (comparison?.status === 'unavailable') return comparison.reason;
  return 'no-data';
}

export function createWeatherService(deps: WeatherServiceDeps) {
  const timeZone = deps.timeZone ?? WEATHER_TIME_ZONE;

  async function read(location: WeatherLocation): Promise<WeatherResponse> {
    const rounded = normalizeWeatherLocation(location);
    const requested = WEATHER_MODELS.map((model) => deps.reader.forecast(rounded, model));
    const outcomes = await Promise.all(requested);
    const models = outcomes
      .filter((outcome): outcome is Extract<WeatherModelOutcome, { status: 'ok' }> => outcome.status === 'ok')
      .map((outcome) => outcome.series)
      .filter((series) => series.points.length > 0);
    if (models.length === 0) {
      return {
        status: 'unavailable',
        now: deps.now().toISOString(),
        location: rounded,
        reason: unavailableReason(outcomes[0], outcomes[1]),
        message: 'No weather model returned usable forecast points.',
      };
    }
    const partialError: WeatherPartialError = models.length < WEATHER_MODELS.length ? 'one-model-unavailable' : 'none';
    const day = userDate(deps.now(), timeZone);
    return {
      status: 'ok',
      projection: {
        location: rounded,
        now: deps.now().toISOString(),
        models,
        agreement: agreementFor(models),
        coverage: coverageFor(models),
        runWindow: chooseRunWindow(models, day, timeZone),
        partialError,
        attribution: WEATHER_ATTRIBUTION,
        termsUrl: WEATHER_TERMS_URL,
      },
    };
  }

  return {
    readWeather: () => read(WEATHER_FALLBACK_LOCATION),
    readWeatherAtLocation: (request: WeatherLocationRequest) => read(deviceWeatherLocation(request)),
  };
}

export { WEATHER_MODEL_PLAN, WEATHER_MODELS };
