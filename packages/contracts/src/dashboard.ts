// Dashboard (DASH1): read-only overview for the phone. Public market data plus honest card placeholders.
// No writes, no identity data, no secrets. The market card is the first card; its provider is reversible.
import { z } from 'zod';

import { WeatherFailureReason, WeatherProjection } from './weather.ts';

// Disallow runtime code generation (eval/Function probe) under strict CSP (script-src 'self') and Cloudflare Workers.
z.config({ jitless: true });

const isoInstant = z.iso.datetime({ offset: true });

/** The four selectable windows for the watched series. Fixed here: the client never names a provider URL. */
export const DASHBOARD_RANGES = ['1W', '1M', '3M', '1Y'] as const;
export const DashboardRange = z.enum(DASHBOARD_RANGES);
export type DashboardRange = z.infer<typeof DashboardRange>;

/**
 * Fixed range plan: the only granularity/span combinations the worker may ask a provider for. 1W/1M/3M fit one Coinbase
 * request (168, 120, 90 buckets); 1Y is daily over ~365 days, which exceeds the provider's 300-candle per-request cap,
 * so the worker fetches it as consecutive windows and merges them (a series may therefore hold up to MAX_MARKET_POINTS).
 * Kept next to the contract so client and worker agree on what a range means.
 */
export const DASHBOARD_RANGE_PLAN: Record<DashboardRange, { readonly granularitySeconds: number; readonly spanSeconds: number }> = {
  '1W': { granularitySeconds: 3_600, spanSeconds: 7 * 86_400 },
  '1M': { granularitySeconds: 21_600, spanSeconds: 30 * 86_400 },
  '3M': { granularitySeconds: 86_400, spanSeconds: 90 * 86_400 },
  '1Y': { granularitySeconds: 86_400, spanSeconds: 365 * 86_400 },
};
/** Series cap across all ranges: a year of daily buckets (365) fits with headroom. One provider request is capped lower. */
export const MAX_MARKET_POINTS = 400;

/** Why a market read has nothing to show. Never carries provider text. */
export const MarketUnavailableReason = z.enum(['timeout', 'malformed', 'provider-error']);
export type MarketUnavailableReason = z.infer<typeof MarketUnavailableReason>;

/** One provider bucket. `time` is the bucket start in provider market time, distinct from when we fetched it. */
export const MarketPoint = z.strictObject({
  time: isoInstant,
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
});
export type MarketPoint = z.infer<typeof MarketPoint>;

export const MarketSeries = z.strictObject({
  range: DashboardRange,
  granularitySeconds: z.number().int().positive(),
  /** Ascending by time. Only buckets the provider actually returned inside the window: gaps stay gaps. */
  points: z.array(MarketPoint).max(MAX_MARKET_POINTS),
  /** Window buckets the provider did not return. The client must show these as gaps, never interpolate them. */
  missingIntervals: z.number().int().nonnegative(),
});
export type MarketSeries = z.infer<typeof MarketSeries>;

/** The current public snapshot. `providerTime` is the provider's own market time; `fetchedAt` (on the card) is ours. */
export const MarketTicker = z.strictObject({
  base: z.literal('BTC'),
  quote: z.literal('USD'),
  provider: z.literal('coinbase'),
  price: z.number().finite().positive(),
  providerTime: isoInstant,
});
export type MarketTicker = z.infer<typeof MarketTicker>;

/** Where a card's fact lives, when a detail view exists. DASH1 builds none, so every card passes null today. */
export const DashboardDrillthrough = z.strictObject({ label: z.string().min(1).max(40), view: z.string().min(1).max(60) });

const cardMeta = {
  title: z.string().min(1).max(60),
  /** Human source name; no secrets, no URLs with credentials. */
  provenance: z.string().min(1).max(120),
  /** When the source observed the fact (provider market time for the ticker); null when there is none. */
  observedAt: isoInstant.nullable(),
  /** When this worker fetched/computed it: the distinction the UI must keep visible. Null when nothing was fetched. */
  fetchedAt: isoInstant.nullable(),
  /** Honest, bounded explanation for a not-ok card. Never invents a number. */
  note: z.string().max(300).nullable(),
  /** Seam for a later detail view. Null until one exists. */
  drillthrough: DashboardDrillthrough.nullable(),
};

/**
 * The BTC/USD card. `series` is null when the current value stands but the candles read failed: partial failure is shown
 * as an absent history, never as invented points. `unavailable` means there is no usable current value either.
 */
export const MarketCard = z.union([
  z.strictObject({ id: z.literal('market'), status: z.literal('ok'), ...cardMeta, ticker: MarketTicker, series: MarketSeries.nullable() }),
  z.strictObject({ id: z.literal('market'), status: z.literal('unavailable'), ...cardMeta, reason: MarketUnavailableReason }),
]);
export type MarketCard = z.infer<typeof MarketCard>;

// ---- Watchlist (WL1): one card per watched symbol, crypto (Coinbase) or fx (Frankfurter / Bank of Russia) ----

/** The kinds a watch item may be, matching the adapter behind it. Adding an item never adds a kind. */
export const WatchItemKind = z.enum(['crypto', 'fx']);
export type WatchItemKind = z.infer<typeof WatchItemKind>;

/** Which watched item a card is about; a client keys by this, never by the human title. */
export const WatchItemRef = z.strictObject({
  symbol: z.string().min(1).max(20),
  type: WatchItemKind,
});
export type WatchItemRef = z.infer<typeof WatchItemRef>;

/**
 * A generalized current value for a watched symbol. Unlike MarketTicker (the fixed BTC/USD coinbase card), base/quote
 * and provider are named per item, so fx pairs and extra crypto pairs fit one card without faking a Coinbase ticker.
 */
export const WatchTicker = z.strictObject({
  base: z.string().min(1).max(10),
  quote: z.string().min(1).max(10),
  provider: z.string().min(1).max(40),
  price: z.number().finite().positive(),
  providerTime: isoInstant,
});
export type WatchTicker = z.infer<typeof WatchTicker>;

/**
 * One watched symbol. `series` is null when the current value stands but the history read failed: partial failure is an
 * absent history, never invented points. `unavailable` means there is no usable current value either, and nothing stale
 * is passed off as current.
 */
export const WatchCard = z.union([
  z.strictObject({ id: z.literal('watchlist'), status: z.literal('ok'), ...cardMeta, item: WatchItemRef, ticker: WatchTicker, series: MarketSeries.nullable() }),
  z.strictObject({ id: z.literal('watchlist'), status: z.literal('unavailable'), ...cardMeta, item: WatchItemRef, reason: MarketUnavailableReason }),
]);
export type WatchCard = z.infer<typeof WatchCard>;

/**
 * AI usage / Health overviews: no approved source is wired in DASH1, so these are honest non-ok cards. The `ok` variant is
 * intentionally absent rather than faked; a later approved DTO (HealthDTO / operational telemetry) widens `status` and
 * adds its payload here, with the client rendering any card by status — no new app-owned database.
 */
export const AiUsageCard = z.strictObject({ id: z.literal('ai-usage'), status: z.enum(['not-configured', 'unavailable']), ...cardMeta });
export type AiUsageCard = z.infer<typeof AiUsageCard>;
export const HealthCard = z.strictObject({ id: z.literal('health'), status: z.enum(['not-configured', 'unavailable']), ...cardMeta });
export type HealthCard = z.infer<typeof HealthCard>;

/**
 * The Weather card carries the same projection as the `/api/weather` read (ADR-0033 W1): a single read model feeds the
 * Dashboard card and the Today morning projection. `unavailable` means no usable model series at all.
 */
export const WeatherCard = z.union([
  z.strictObject({ id: z.literal('weather'), status: z.literal('ok'), ...cardMeta, projection: WeatherProjection }),
  z.strictObject({ id: z.literal('weather'), status: z.literal('unavailable'), ...cardMeta, reason: WeatherFailureReason }),
]);
export type WeatherCard = z.infer<typeof WeatherCard>;

export const DashboardCard = z.union([MarketCard, WatchCard, WeatherCard, AiUsageCard, HealthCard]);
export type DashboardCard = z.infer<typeof DashboardCard>;

/** A bounded list, but one that grows with the watchlist config: four fixed cards plus one per watched item. */
export const MAX_DASHBOARD_CARDS = 24;

export const DashboardResponse = z.strictObject({
  /** Server time, so staleness never depends on the phone clock (same rule as ScoutsResponse). */
  now: isoInstant,
  cards: z.array(DashboardCard).max(MAX_DASHBOARD_CARDS),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

/** The 60-second refresh: only the current value, never the history (ADR/DASH1). */
export const MarketTickerResponse = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), now: isoInstant, ticker: MarketTicker, fetchedAt: isoInstant }),
  z.strictObject({ status: z.literal('unavailable'), now: isoInstant, reason: MarketUnavailableReason }),
]);
export type MarketTickerResponse = z.infer<typeof MarketTickerResponse>;

/** Fixed public provider facts (no secrets). Exported so the worker and its tests share one allowlist. */
export const MARKET_PROVIDER = 'coinbase';
export const MARKET_PRODUCT = 'BTC-USD';
export const MARKET_BASE_URL = 'https://api.exchange.coinbase.com';
