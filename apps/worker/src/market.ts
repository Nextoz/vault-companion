// Public market data for the Dashboard (DASH1). One allowlisted provider, fixed product and ranges, bounded fetches,
// honest failures. No secrets, no writes, no identity; nothing here touches the vault or GitHub.
import {
  DASHBOARD_RANGE_PLAN,
  MARKET_BASE_URL,
  MARKET_PRODUCT,
  MARKET_PROVIDER,
  MAX_MARKET_POINTS,
  type DashboardRange,
  type MarketPoint,
  type MarketSeries,
  type MarketTicker,
  type MarketUnavailableReason,
  type WatchTicker,
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

/**
 * The only provider URLs the worker may build: a fixed host with a configured product (BTC-USD for the legacy card,
 * any allowlisted symbol for a watch item), numeric times and an enum granularity.
 */
export const tickerUrl = (product: string = MARKET_PRODUCT): string => `${MARKET_BASE_URL}/products/${product}/ticker`;
export const candlesUrl = (range: DashboardRange, startSec: number, endSec: number, product: string = MARKET_PRODUCT): string =>
  `${MARKET_BASE_URL}/products/${product}/candles?granularity=${DASHBOARD_RANGE_PLAN[range].granularitySeconds}&start=${startSec}&end=${endSec}`;

/** B9: Coinbase answers `/candles` with 400 when User-Agent is absent, and a Worker's fetch sends none by default. */
export const MARKET_HEADERS = { Accept: 'application/json', 'User-Agent': 'vault-companion' } as const;

class TimedOut extends Error {}

export interface BoundedTextOptions {
  readonly timeoutMs: number;
  readonly headers?: HeadersInit;
  /** Optional non-UTF-8 decoder (Bank of Russia answers windows-1251). */
  readonly decode?: (bytes: Uint8Array) => string;
}

/**
 * A bounded, timed provider read shared by every adapter: the caller's timeout aborts the request, a 256 KiB cap is
 * enforced from content-length and again while streaming, and a decoder can replace the default UTF-8 text. The promise
 * race also bounds a fetch implementation that ignores the abort signal.
 */
export async function readBoundedText(
  fetchImpl: typeof fetch,
  url: string,
  options: BoundedTextOptions,
): Promise<{ ok: true; text: string } | { ok: false; reason: MarketUnavailableReason }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new TimedOut());
    }, options.timeoutMs);
  });
  try {
    const fetching = fetchImpl(url, { signal: abort.signal, headers: options.headers ?? MARKET_HEADERS }).then((response) => {
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
    const text = (options.decode ?? ((bytes: Uint8Array) => new TextDecoder().decode(bytes)))(bytes);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: e instanceof TimedOut || abort.signal.aborted ? 'timeout' : 'provider-error' };
  } finally {
    clearTimeout(timer);
    void reader?.cancel().catch(() => {});
  }
}

async function readJson(fetchImpl: typeof fetch, url: string, timeoutMs: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: MarketUnavailableReason }> {
  const res = await readBoundedText(fetchImpl, url, { timeoutMs, headers: MARKET_HEADERS });
  if (!res.ok) return res;
  try {
    return { ok: true, body: JSON.parse(res.text) };
  } catch {
    return { ok: false, reason: 'malformed' };
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

/** The same string-number discipline as parseTicker, but for any allowlisted product and its named base/quote. */
export function parseCoinbaseTicker(body: unknown, base: string, quote: string): WatchTicker | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const price = Number(raw.price);
  const time = typeof raw.time === 'string' ? Date.parse(raw.time) : NaN;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) return null;
  return { base, quote, provider: MARKET_PROVIDER, price, providerTime: new Date(time).toISOString() };
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
export function parseCandles(body: unknown, range: DashboardRange, startSec: number, endSec: number, granularitySeconds: number = DASHBOARD_RANGE_PLAN[range].granularitySeconds): MarketSeries | null {
  if (!Array.isArray(body)) return null;
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
