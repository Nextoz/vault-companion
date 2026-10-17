// Cached Energi Data Service adapter for the power monitor (M4b). The client can never name a URL: only the three
// fixed dataset endpoints below are fetched, server-side. Parsed rows are cached per Copenhagen day and re-projected
// on every read, because the now hour and the cheapest upcoming window move while the rows do not.
import { POWER_REASON_NOTES, type PowerResponse, type PowerUnavailableReason, type WeatherFailureReason } from '@vault-companion/contracts';
import { userDate } from '@vault-companion/domain';
import { parseCo2Body, parsePriceBody, projectPower, type Co2Row, type PriceRow } from './power.ts';
import { readJson } from './weather-provider.ts';

/** A request the provider has not answered by then is abandoned and reported as a timeout. */
export const POWER_FETCH_TIMEOUT_MS = 8_000;
/** Spot prices and CO2 change slowly: parsed rows are fresh for 15 minutes and never polled on every request. */
export const POWER_CACHE_TTL_MS = 15 * 60_000;

const FILTER = encodeURIComponent('{"PriceArea":["DK2"]}');

/** The next Copenhagen calendar date; never `now + 24 h`, because DST days are not 24 hours long. */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The only provider URLs this adapter may build. `start`/`end` are Danish local midnights of Copenhagen dates. */
export function powerUrls(today: string, dayAfterTomorrow: string) {
  return {
    prices: `https://api.energidataservice.dk/dataset/DayAheadPrices?start=${today}T00:00&end=${dayAfterTomorrow}T00:00&filter=${FILTER}&sort=${encodeURIComponent('TimeUTC asc')}&limit=300`,
    co2: `https://api.energidataservice.dk/dataset/CO2Emis?filter=${FILTER}&sort=${encodeURIComponent('Minutes5UTC desc')}&limit=12`,
    co2Prog: `https://api.energidataservice.dk/dataset/CO2EmisProg?start=${today}T00:00&filter=${FILTER}&sort=${encodeURIComponent('Minutes5UTC asc')}&limit=400`,
  };
}

interface PowerCache {
  readonly key: string;
  readonly at: number;
  readonly prices: readonly PriceRow[];
  readonly co2: readonly Co2Row[] | null;
  readonly co2Prog: readonly Co2Row[] | null;
}

export interface PowerProviderDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly timeZone: string;
  /** Test seams for the abort timer and cache TTL. */
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
}

/** readJson reports weather reasons; its `no-data` cannot occur there and is not a power reason. */
const toPowerReason = (reason: WeatherFailureReason): PowerUnavailableReason =>
  reason === 'timeout' || reason === 'malformed' || reason === 'provider-error' ? reason : 'provider-error';

export function createPowerProvider(deps: PowerProviderDeps) {
  const timeoutMs = deps.timeoutMs ?? POWER_FETCH_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? POWER_CACHE_TTL_MS;
  let cache: PowerCache | null = null;
  let inflight: Promise<PowerResponse> | null = null;

  const project = (entry: PowerCache, nowMs: number): PowerResponse =>
    projectPower({
      prices: entry.prices,
      co2: entry.co2,
      co2Prog: entry.co2Prog,
      now: new Date(nowMs),
      fetchedAt: new Date(entry.at).toISOString(),
      timeZone: deps.timeZone,
    });

  const refresh = async (nowMs: number, today: string, cached: PowerCache | null): Promise<PowerResponse> => {
    const urls = powerUrls(today, nextDay(nextDay(today)));
    const [pricesRes, co2Res, co2ProgRes] = await Promise.all([
      readJson(deps.fetch, urls.prices, timeoutMs),
      readJson(deps.fetch, urls.co2, timeoutMs),
      readJson(deps.fetch, urls.co2Prog, timeoutMs),
    ]);
    const now = new Date(nowMs);
    const prices = pricesRes.ok ? parsePriceBody(pricesRes.body) : null;
    if (!pricesRes.ok || prices === null) {
      // A failed refresh reuses the last rows with their ORIGINAL fetchedAt: visible stale, never repainted fresh.
      if (cached && cached.key === today) return project(cached, nowMs);
      const reason: PowerUnavailableReason = pricesRes.ok ? 'malformed' : toPowerReason(pricesRes.reason);
      return { status: 'unavailable', now: now.toISOString(), reason, note: POWER_REASON_NOTES[reason] };
    }
    // A failing or unparseable CO2 input never fails the response: that input is simply null (co2 may become null).
    const co2 = co2Res.ok ? parseCo2Body(co2Res.body) : null;
    const co2Prog = co2ProgRes.ok ? parseCo2Body(co2ProgRes.body) : null;
    cache = { key: today, at: nowMs, prices, co2, co2Prog };
    return project(cache, nowMs);
  };

  return {
    async read(): Promise<PowerResponse> {
      const nowMs = deps.now();
      const today = userDate(new Date(nowMs), deps.timeZone);
      const cached = cache;
      if (cached && cached.key === today && nowMs - cached.at < cacheTtlMs) {
        // No fetch: the rows are fresh, but the projection is recomputed because nowHour moves.
        return project(cached, nowMs);
      }
      if (!inflight) {
        inflight = refresh(nowMs, today, cached).finally(() => { inflight = null; });
      }
      // Concurrent reads share one in-flight refresh instead of starting a second one.
      return inflight;
    },
  };
}
