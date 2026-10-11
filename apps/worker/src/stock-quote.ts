// Stock quotes (WL4a). The Yahoo Finance chart endpoint is keyless but unofficial, so the parser is defensive and the
// adapter stays swappable. ONE fetch per symbol yields both the delayed ticker and the daily history; every range
// (1W/1M/3M/1Y) is a slice of that same daily array, never a second subrequest. No secrets, no values in logs.
import {
  DASHBOARD_RANGE_PLAN,
  MAX_MARKET_POINTS,
  type DashboardRange,
  type MarketPoint,
  type MarketSeries,
  type WatchTicker,
} from '@vault-companion/contracts';

/** Fixed public provider facts (no secrets). Yahoo's chart endpoint is unofficial: keep it behind this one module. */
export const STOCK_PROVIDER = 'Yahoo Finance';
export const STOCK_QUOTE = 'USD';
export const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
/** Yahoo answers 429 without a User-Agent; the header also names the caller. */
export const YAHOO_HEADERS = { Accept: 'application/json', 'User-Agent': 'vault-companion' } as const;

const DAY_SECONDS = 86_400;

/** The only URL the worker builds for a stock; the client never names a provider URL. */
export const yahooChartUrl = (symbol: string): string => `${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}?range=1y&interval=1d`;

/** One trading day the provider actually returned. */
export interface StockDailyPoint {
  readonly time: string;
  readonly close: number;
}

/** A delayed quote plus the daily closes behind it; ranges slice `daily`, they never refetch. */
export interface StockQuote {
  readonly ticker: WatchTicker;
  /** Ascending by time; provider nulls are skipped, never zero-filled. */
  readonly daily: readonly StockDailyPoint[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** A finite, positive price. Null, 0, NaN, Infinity and non-numbers ("n/a") are refused, never coerced. */
const price = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Yahoo chart v8: `chart.result[0]` carries `meta` (currency, regularMarketPrice, regularMarketTime in unix seconds) and
 * the daily series (`timestamp[]` + `indicators.quote[0].close[]`, nulls where the provider has no print). A non-USD
 * instrument, a missing/zero/non-finite price, an empty result or a time we cannot read is refused: never a coercion,
 * never a zero-filled bucket. A quote with an unusable/missing series keeps the ticker and an empty `daily` (the card
 * then shows the current value only).
 */
export function parseYahooQuote(body: unknown, symbol: string): StockQuote | null {
  const chart = record(record(body)?.chart);
  if (!chart) return null;
  const results = chart.result;
  if (!Array.isArray(results) || results.length === 0) return null;
  const result = record(results[0]);
  if (!result) return null;
  const meta = record(result.meta);
  if (!meta) return null;
  if (meta.currency !== STOCK_QUOTE) return null; // USD guard: a foreign-currency print is not this card's price
  const marketPrice = price(meta.regularMarketPrice);
  const marketTime = meta.regularMarketTime;
  if (marketPrice === null || typeof marketTime !== 'number' || !Number.isInteger(marketTime) || marketTime <= 0) return null;
  const ticker: WatchTicker = {
    base: symbol,
    quote: STOCK_QUOTE,
    provider: STOCK_PROVIDER,
    price: marketPrice,
    providerTime: new Date(marketTime * 1000).toISOString(),
  };

  const timestamps = result.timestamp;
  const indicators = record(result.indicators);
  const quotes = indicators ? indicators.quote : undefined;
  const firstQuote = Array.isArray(quotes) ? record(quotes[0]) : null;
  const closes = firstQuote ? firstQuote.close : undefined;
  const daily: StockDailyPoint[] = [];
  if (Array.isArray(timestamps) && Array.isArray(closes)) {
    const length = Math.min(timestamps.length, closes.length);
    for (let index = 0; index < length; index += 1) {
      const time = timestamps[index];
      const close = price(closes[index]);
      if (typeof time !== 'number' || !Number.isInteger(time) || time <= 0 || close === null) continue;
      daily.push({ time: new Date(time * 1000).toISOString(), close });
    }
    daily.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }
  return { ticker, daily };
}

/**
 * Slice the cached daily closes to one range: daily buckets over DASHBOARD_RANGE_PLAN's span, the window ending after
 * today (UTC). Days the provider never returned (weekends, holidays, and everything before a recent listing) stay
 * missing: `missingIntervals` counts them and the client draws gaps, never interpolated or invented points. A window
 * with no usable print is refused (null), so the caller reports an unavailable history rather than a fabricated line.
 */
export function buildStockSeries(quote: StockQuote, range: DashboardRange, nowMs: number): MarketSeries | null {
  const granularitySeconds = DAY_SECONDS;
  const endSec = Math.floor(nowMs / 1000 / granularitySeconds) * granularitySeconds + granularitySeconds;
  const startSec = endSec - DASHBOARD_RANGE_PLAN[range].spanSeconds;
  const points: MarketPoint[] = [];
  for (const day of quote.daily) {
    const seconds = Date.parse(day.time) / 1000;
    if (!Number.isInteger(seconds) || seconds < startSec || seconds >= endSec) continue;
    points.push({ time: day.time, open: day.close, high: day.close, low: day.close, close: day.close });
  }
  if (points.length === 0) return null;
  const capped = points.slice(-MAX_MARKET_POINTS);
  const expected = Math.floor((endSec - startSec) / granularitySeconds);
  return { range, granularitySeconds, points: capped, missingIntervals: Math.max(0, expected - capped.length) };
}
