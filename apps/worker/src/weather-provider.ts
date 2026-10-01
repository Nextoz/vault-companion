// Public Open-Meteo weather adapter (ADR-0033 W1). Fixed endpoints/models/fields only; the client can never name a URL
// or model. Server-side fetch, strict unit/time/value validation, and a bounded cache keyed by rounded location/model.
import {
  roundWeatherCoordinate,
  WEATHER_FORECAST_HOURS,
  WEATHER_MODEL_PLAN,
  type WeatherFailureReason,
  type WeatherLocation,
  type WeatherModel,
  type WeatherModelSeries,
  type WeatherPoint,
} from '@vault-companion/contracts';
import type { WeatherModelOutcome } from '@vault-companion/domain';

/** A request the provider has not answered by then is abandoned and reported as a timeout. */
export const WEATHER_FETCH_TIMEOUT_MS = 8_000;
/** Provider bodies above this are refused unread; 48 hourly points for two models are far smaller. */
export const WEATHER_MAX_BODY_BYTES = 256 * 1024;
/** Forecasts change slowly: one cache entry is fresh for 15 minutes and is never polled every request. */
export const WEATHER_CACHE_TTL_MS = 15 * 60_000;
/** Two models at the fallback plus two models at one device-rounded location: bounded, then oldest entry is dropped. */
export const WEATHER_CACHE_MAX_ENTRIES = 4;

const HOURLY_FIELDS = 'temperature_2m,rain,wind_speed_10m';

/** The only provider URLs this adapter may build. Coordinates are already rounded before this function is called. */
export function weatherUrl(location: WeatherLocation, model: WeatherModel): string {
  const plan = WEATHER_MODEL_PLAN[model];
  return `${plan.baseUrl}?latitude=${location.latitude}&longitude=${location.longitude}&hourly=${encodeURIComponent(HOURLY_FIELDS)}&forecast_hours=${WEATHER_FORECAST_HOURS}&wind_speed_unit=ms&timeformat=unixtime&timezone=GMT&models=${plan.selector}`;
}

class TimedOut extends Error {}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: WeatherFailureReason }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new TimedOut());
    }, timeoutMs);
  });
  try {
    const fetching = fetchImpl(url, { signal: abort.signal, headers: { Accept: 'application/json' } }).then((response) => {
      if (abort.signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    const res = await Promise.race([fetching, timedOut]);
    reader = res.body?.getReader();
    if (!res.ok) return { ok: false, reason: 'provider-error' };
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > WEATHER_MAX_BODY_BYTES) return { ok: false, reason: 'malformed' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        size += value.byteLength;
        if (size > WEATHER_MAX_BODY_BYTES) {
          abort.abort();
          return { ok: false, reason: 'malformed' };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  } catch (e) {
    return { ok: false, reason: e instanceof TimedOut || abort.signal.aborted ? 'timeout' : 'provider-error' };
  } finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}

function optionalNumber(value: unknown, minimum = -Infinity): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) return undefined;
  return value;
}

/**
 * Strict parser for the verified Open-Meteo shape. Units must be exactly unixtime/°C/mm/m/s with offset 0, times must be
 * strictly increasing unix seconds, and any non-null invalid value refuses the body. Provider nulls stay null: the UI
 * draws them as gaps.
 */
export function parseWeatherBody(body: unknown, model: WeatherModel, retrievedAt: string): WeatherModelSeries | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (raw.utc_offset_seconds !== 0) return null;
  const units = raw.hourly_units;
  if (typeof units !== 'object' || units === null) return null;
  const unit = units as Record<string, unknown>;
  if (unit.time !== 'unixtime' || unit.temperature_2m !== '°C' || unit.rain !== 'mm' || unit.wind_speed_10m !== 'm/s') return null;
  const hourly = raw.hourly;
  if (typeof hourly !== 'object' || hourly === null) return null;
  const h = hourly as Record<string, unknown>;
  const times = h.time;
  const temperatures = h.temperature_2m;
  const rains = h.rain;
  const winds = h.wind_speed_10m;
  if (!Array.isArray(times) || !Array.isArray(temperatures) || !Array.isArray(rains) || !Array.isArray(winds)) return null;
  if (times.length === 0 || times.length > WEATHER_FORECAST_HOURS) return null;
  if (temperatures.length !== times.length || rains.length !== times.length || winds.length !== times.length) return null;

  const points: WeatherPoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < times.length; i++) {
    const rawTime = times[i];
    if (typeof rawTime !== 'number' || !Number.isInteger(rawTime) || rawTime <= previous || rawTime % 3600 !== 0) return null;
    if (rawTime - (times[0] as number) >= WEATHER_FORECAST_HOURS * 3600) return null;
    const instant = new Date(rawTime * 1000);
    if (!Number.isFinite(instant.getTime())) return null;
    previous = rawTime;
    const temperatureC = optionalNumber(temperatures[i]);
    const rainMm = optionalNumber(rains[i], 0);
    const windMs = optionalNumber(winds[i], 0);
    if (temperatureC === undefined || rainMm === undefined || windMs === undefined) return null;
    points.push({ time: instant.toISOString(), temperatureC, rainMm, windMs });
  }
  const plan = WEATHER_MODEL_PLAN[model];
  return {
    model,
    label: plan.label,
    resolutionKm: plan.resolutionKm,
    sourceUrl: plan.sourceUrl,
    retrievedAt,
    expectedPoints: WEATHER_FORECAST_HOURS,
    points,
    missingIntervals: WEATHER_FORECAST_HOURS - points.length + points.filter((p) => p.temperatureC === null || p.rainMm === null || p.windMs === null).length,
  };
}

export interface WeatherProviderDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Test seams for the abort timer and cache TTL. */
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

export function createWeatherProvider(deps: WeatherProviderDeps) {
  const timeoutMs = deps.timeoutMs ?? WEATHER_FETCH_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? WEATHER_CACHE_TTL_MS;
  const cache = new Map<string, { at: number; series: WeatherModelSeries }>();
  const inflight = new Map<string, Promise<WeatherModelOutcome>>();

  const cacheKey = (location: WeatherLocation, model: WeatherModel): string =>
    `${roundWeatherCoordinate(location.latitude)},${roundWeatherCoordinate(location.longitude)},${model}`;

  const fetchModel = async (location: WeatherLocation, model: WeatherModel): Promise<WeatherModelOutcome> => {
    const res = await readJson(deps.fetch, weatherUrl(location, model), timeoutMs);
    if (!res.ok) return { status: 'unavailable', reason: res.reason };
    const fetchedAt = new Date(deps.now()).toISOString();
    const series = parseWeatherBody(res.body, model, fetchedAt);
    return series ? { status: 'ok', series, fresh: true } : { status: 'unavailable', reason: 'malformed' };
  };

  const prune = (): void => {
    while (cache.size > WEATHER_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    async forecast(location: WeatherLocation, model: WeatherModel): Promise<WeatherModelOutcome> {
      const key = cacheKey(location, model);
      const cached = cache.get(key);
      if (cached && deps.now() - cached.at < cacheTtlMs) {
        return { status: 'ok', series: cached.series, fresh: true };
      }
      let pending = inflight.get(key);
      if (!pending) {
        if (inflight.size >= WEATHER_CACHE_MAX_ENTRIES) {
          return cached ? { status: 'ok', series: cached.series, fresh: false } : { status: 'unavailable', reason: 'provider-error' };
        }
        pending = fetchModel(location, model).finally(() => { inflight.delete(key); });
        inflight.set(key, pending);
      }
      const fresh = await pending;
      if (fresh.status === 'ok') {
        cache.set(key, { at: Date.parse(fresh.series.retrievedAt), series: fresh.series });
        prune();
        return fresh;
      }
      // A failed refresh reuses the last known series with its ORIGINAL retrievedAt: visible stale, never repainted fresh.
      return cached ? { status: 'ok', series: cached.series, fresh: false } : fresh;
    },
  };
}
