// Cached DMI + Open-Meteo adapter for the barometer monitor. The client can never name a URL: only the fixed
// station and model endpoints below are fetched, server-side. Parsed rows are cached for ten minutes and
// re-projected on every read, because freshness moves with time while the rows do not.
import {
  BAROMETER_LATITUDE,
  BAROMETER_LONGITUDE,
  BAROMETER_REASON_NOTES,
  BAROMETER_STATIONS,
  type BarometerResponse,
  type BarometerUnavailableReason,
  type WeatherFailureReason,
} from '@vault-companion/contracts';
import { parseDmiBody, parseOpenMeteoBody, projectBarometer, type DmiStation, type ModelSeries } from './barometer.ts';
import { readJson } from './weather-provider.ts';

/** A request the provider has not answered by then is abandoned and reported as a timeout. */
export const BAROMETER_FETCH_TIMEOUT_MS = 8_000;
/** Station pressure changes slowly: parsed rows are fresh for 10 minutes and never polled on every request. */
export const BAROMETER_CACHE_TTL_MS = 10 * 60_000;

/** The fixed DMI metObs query for one station; the station ids come from BAROMETER_STATIONS, never the client. */
const stationUrl = (id: string): string =>
  `https://opendataapi.dmi.dk/v2/metObs/collections/observation/items?stationId=${id}&parameterId=pressure_at_sea&period=latest-day&limit=40`;

/** The only provider URLs this adapter may build: one fixed query per DMI station and the model fallback. */
export function barometerUrls(): { stations: Record<string, string>; model: string } {
  return {
    stations: Object.fromEntries(BAROMETER_STATIONS.map((id): [string, string] => [id, stationUrl(id)])),
    model: `https://api.open-meteo.com/v1/forecast?latitude=${BAROMETER_LATITUDE}&longitude=${BAROMETER_LONGITUDE}&current=pressure_msl&hourly=pressure_msl&past_days=1&models=dmi_seamless`,
  };
}

interface BarometerCache {
  readonly at: number;
  readonly stations: readonly DmiStation[];
  readonly model: ModelSeries | null;
}

export interface BarometerProviderDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Test seams for the abort timer and cache TTL. */
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

/** readJson reports weather reasons; its `no-data` cannot occur here and is not a barometer reason. */
const toBarometerReason = (reason: WeatherFailureReason): BarometerUnavailableReason =>
  reason === 'timeout' || reason === 'malformed' || reason === 'provider-error' ? reason : 'provider-error';

export function createBarometerProvider(deps: BarometerProviderDeps) {
  const timeoutMs = deps.timeoutMs ?? BAROMETER_FETCH_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? BAROMETER_CACHE_TTL_MS;
  let cache: BarometerCache | null = null;
  let inflight: Promise<BarometerResponse> | null = null;

  const project = (entry: BarometerCache, nowMs: number): BarometerResponse =>
    projectBarometer({
      stations: entry.stations,
      model: entry.model,
      now: new Date(nowMs),
      fetchedAt: new Date(entry.at),
    });

  const refresh = async (nowMs: number, cached: BarometerCache | null): Promise<BarometerResponse> => {
    const urls = barometerUrls();
    const now = new Date(nowMs);
    // The first failure reason seen decides the reported reason; 'empty' is reserved for all-success refreshes.
    let failure: BarometerUnavailableReason | null = null;
    const noteFailure = (reason: BarometerUnavailableReason): void => {
      if (failure === null) failure = reason;
    };

    // 1. Both stations in parallel; only bodies that parse to a station are kept ('empty' and null are not).
    const results = await Promise.all(BAROMETER_STATIONS.map((id) => readJson(deps.fetch, stationUrl(id), timeoutMs)));
    const stations: DmiStation[] = [];
    for (const result of results) {
      if (!result.ok) {
        noteFailure(toBarometerReason(result.reason));
        continue;
      }
      const parsed = parseDmiBody(result.body);
      if (parsed === null) noteFailure('malformed');
      else if (parsed !== 'empty') stations.push(parsed);
    }

    // 2. Fresh station measurements win; when one is usable the model is not fetched at all.
    const stationProjection = projectBarometer({ stations, model: null, now, fetchedAt: now });
    if (stationProjection.status === 'ok') {
      cache = { at: nowMs, stations, model: null };
      return stationProjection;
    }

    // 3. The model stands in when no station is fresh.
    const modelResult = await readJson(deps.fetch, urls.model, timeoutMs);
    const model = modelResult.ok ? parseOpenMeteoBody(modelResult.body) : null;
    if (!modelResult.ok) noteFailure(toBarometerReason(modelResult.reason));
    else if (model === null) noteFailure('malformed');
    const projection = projectBarometer({ stations, model, now, fetchedAt: now });
    if (projection.status === 'ok') {
      cache = { at: nowMs, stations, model };
      return projection;
    }

    // 4. Nothing usable: an earlier cache is returned with its ORIGINAL fetchedAt, visibly stale, never repainted.
    if (cached !== null) {
      const stale = project(cached, nowMs);
      if (stale.status === 'ok') return stale;
    }
    const reason = failure ?? 'empty';
    return { status: 'unavailable', now: now.toISOString(), reason, note: BAROMETER_REASON_NOTES[reason] };
  };

  return {
    async read(): Promise<BarometerResponse> {
      const nowMs = deps.now();
      const cached = cache;
      if (cached !== null && nowMs - cached.at < cacheTtlMs) {
        // No fetch: the rows are fresh, but the projection is recomputed because freshness moves with time.
        return project(cached, nowMs);
      }
      if (!inflight) {
        inflight = refresh(nowMs, cached).finally(() => {
          inflight = null;
        });
      }
      // Concurrent reads share one in-flight refresh instead of starting a second one.
      return inflight;
    },
  };
}
