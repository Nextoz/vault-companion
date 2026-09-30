// Public market data for the Dashboard (DASH1). One allowlisted provider, fixed product and ranges, bounded fetches,
// honest failures. No secrets, no writes, no identity; nothing here touches the vault or GitHub.
import {
  DASHBOARD_RANGE_PLAN,
  MARKET_BASE_URL,
  MARKET_PRODUCT,
  MAX_MARKET_POINTS,
  type DashboardRange,
  type MarketPoint,
  type MarketSeries,
  type MarketTicker,
  type MarketUnavailableReason,
} from '@vault-companion/contracts';

/** A request the provider has not answered by then is abandoned and reported as a timeout. */
export const FETCH_TIMEOUT_MS = 8_000;
/** Provider bodies above this are refused unread; candles for our ranges are far smaller. */
export const MAX_BODY_BYTES = 256 * 1024;
/** The current value is cheap: refreshed about once a minute (docs/DASH1). */
export const TICKER_TTL_MS = 60_000;
/** History changes slowly: it is cached well past a minute so it is never polled every 60 seconds. */
export const SERIES_TTL_MS: Record<DashboardRange, number> = { '1W': 10 * 60_000, '1M': 30 * 60_000, '3M': 60 * 60_000 };

export type MarketFailure = { readonly status: 'unavailable'; readonly reason: MarketUnavailableReason };
export type TickerOutcome = { readonly status: 'ok'; readonly ticker: MarketTicker; readonly fetchedAt: number } | MarketFailure;
export type SeriesOutcome = { readonly status: 'ok'; readonly series: MarketSeries; readonly fetchedAt: number } | MarketFailure;

/** The only provider URLs the worker may build: a fixed host/product with numeric times and an enum granularity. */
export const tickerUrl = (): string => `${MARKET_BASE_URL}/products/${MARKET_PRODUCT}/ticker`;
export const candlesUrl = (range: DashboardRange, startSec: number, endSec: number): string =>
  `${MARKET_BASE_URL}/products/${MARKET_PRODUCT}/candles?granularity=${DASHBOARD_RANGE_PLAN[range].granularitySeconds}&start=${startSec}&end=${endSec}`;

class TimedOut extends Error {}

async function readJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: MarketUnavailableReason }> {
  const abort = new AbortController();
  // A timer rather than the signal alone: the promise race also bounds a fetch implementation that ignores the signal.
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
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, reason: 'malformed' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timedOut]);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
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
    const text = new TextDecoder().decode(bytes);
    try {
      return { ok: true, body: JSON.parse(text) };
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

/** Coinbase ticker: `{ price, time, ... }` with string numbers. Anything else is refused, never coerced blindly. */
export function parseTicker(body: unknown): MarketTicker | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const price = Number(raw.price);
  const time = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return null;
  return { base: 'BTC', quote: 'USD', provider: 'coinbase', price, providerTime: new Date(time).toISOString() };
}

/** One provider bucket: `[time, low, high, open, close, volume]`, oldest or newest first. */
function parsePoint(row: unknown, granularitySeconds: number, startSec: number, endSec: number): MarketPoint | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const time = Number(row[0]);
  if (!Number.isInteger(time) || time < startSec || time >= endSec) return null; // drops prestart/out-of-window buckets
  if (time % granularitySeconds !== 0) return null; // off the bucket grid: refuse rather than mislabel
  const low = Number(row[1]);
  const high = Number(row[2]);
  const open = Number(row[3]);
  const close = Number(row[4]);
  if (![low, high, open, close].every((n) => Number.isFinite(n))) return null;
  if (high < low || high < open || high < close || low > open || low > close) return null; // incoherent OHLC
  return { time: new Date(time * 1000).toISOString(), open, high, low, close };
}

/**
 * Coinbase candles: an array of buckets. Malformed rows are dropped (never fatal); the surviving buckets are sorted and
 * deduped, capped at MAX_MARKET_POINTS. `missingIntervals` counts window buckets the provider did not return: the client
 * draws those as gaps and never interpolates them.
 */
export function parseCandles(body: unknown, range: DashboardRange, startSec: number, endSec: number): MarketSeries | null {
  if (!Array.isArray(body)) return null;
  const granularitySeconds = DASHBOARD_RANGE_PLAN[range].granularitySeconds;
  const byTime = new Map<number, MarketPoint>();
  for (const row of body) {
    const point = parsePoint(row, granularitySeconds, startSec, endSec);
    if (!point) continue;
    byTime.set(Date.parse(point.time), point);
  }
  const points = [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-MAX_MARKET_POINTS);
  const expected = Math.floor((endSec - startSec) / granularitySeconds);
  return { range, granularitySeconds, points, missingIntervals: Math.max(0, expected - points.length) };
}

export interface MarketSource {
  ticker(): Promise<TickerOutcome>;
  series(range: DashboardRange): Promise<SeriesOutcome>;
}

export interface MarketSourceDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Test seam for the abort timer. */
  readonly timeoutMs?: number;
}

export function createMarketSource(deps: MarketSourceDeps): MarketSource {
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  let tickerCache: { at: number; ticker: MarketTicker } | null = null;
  const seriesCache = new Map<DashboardRange, { at: number; series: MarketSeries }>();
  let tickerInflight: Promise<TickerOutcome> | null = null;
  const seriesInflight = new Map<DashboardRange, Promise<SeriesOutcome>>();

  const fetchTicker = async (): Promise<TickerOutcome> => {
    const res = await readJson(deps.fetch, tickerUrl(), timeoutMs);
    if (!res.ok) return { status: 'unavailable', reason: res.reason };
    const ticker = parseTicker(res.body);
    return ticker ? { status: 'ok', ticker, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
  };

  const fetchSeries = async (range: DashboardRange): Promise<SeriesOutcome> => {
    const { spanSeconds, granularitySeconds } = DASHBOARD_RANGE_PLAN[range];
    const nowSec = Math.floor(deps.now() / 1000);
    const endSec = Math.floor(nowSec / granularitySeconds) * granularitySeconds;
    const startSec = endSec - spanSeconds;
    const res = await readJson(deps.fetch, candlesUrl(range, startSec, endSec), timeoutMs);
    if (!res.ok) return { status: 'unavailable', reason: res.reason };
    const series = parseCandles(res.body, range, startSec, endSec);
    return series ? { status: 'ok', series, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
  };

  return {
    async ticker() {
      if (tickerCache && deps.now() - tickerCache.at < TICKER_TTL_MS) return { status: 'ok', ticker: tickerCache.ticker, fetchedAt: tickerCache.at };
      if (!tickerInflight) tickerInflight = fetchTicker().finally(() => { tickerInflight = null; });
      const fresh = await tickerInflight;
      if (fresh.status === 'ok') {
        tickerCache = { at: fresh.fetchedAt, ticker: fresh.ticker };
        return fresh;
      }
      // The provider failed: last known data is returned with its ORIGINAL fetchedAt, so the client can show it stale.
      return tickerCache ? { status: 'ok', ticker: tickerCache.ticker, fetchedAt: tickerCache.at } : fresh;
    },
    async series(range) {
      const cached = seriesCache.get(range);
      if (cached && deps.now() - cached.at < SERIES_TTL_MS[range]) return { status: 'ok', series: cached.series, fetchedAt: cached.at };
      let inflight = seriesInflight.get(range);
      if (!inflight) {
        inflight = fetchSeries(range).finally(() => { seriesInflight.delete(range); });
        seriesInflight.set(range, inflight);
      }
      const fresh = await inflight;
      if (fresh.status === 'ok') {
        seriesCache.set(range, { at: fresh.fetchedAt, series: fresh.series });
        return fresh;
      }
      return cached ? { status: 'ok', series: cached.series, fetchedAt: cached.at } : fresh;
    },
  };
}
