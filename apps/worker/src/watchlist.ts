// Watchlist backend (WL1). One config array drives one Dashboard card per watched symbol. Each kind has one adapter
// behind a shared interface, and every read copies market.ts discipline: bounded fetches, per-type TTL caches, defensive
// parsing, and an honest 'unavailable' instead of a guessed or stale-as-current value. No secrets, no values in logs.
import {
  DASHBOARD_RANGE_PLAN,
  type DashboardRange,
  type MarketSeries,
  type MarketUnavailableReason,
  type WatchTicker,
} from '@vault-companion/contracts';
import {
  FETCH_TIMEOUT_MS,
  MARKET_HEADERS,
  SERIES_TTL_MS,
  TICKER_TTL_MS,
  type BoundedTextOptions,
  parseCandles,
  parseCoinbaseTicker,
  readCandleRows,
  readBoundedText,
  tickerUrl,
} from './market.ts';

export type WatchItemType = 'crypto' | 'fx';

/** One watched symbol. `base`/`quote` are optional: when omitted they are read from the symbol separator. */
export interface WatchItem {
  readonly symbol: string;
  readonly type: WatchItemType;
  readonly name: string;
  readonly base?: string;
  readonly quote?: string;
}

/** THE config: adding a card is adding one line here; no other code changes. */
export const WATCHLIST: readonly WatchItem[] = [
  { symbol: 'BTC-USD', type: 'crypto', name: 'BTC / USD', base: 'BTC', quote: 'USD' },
  { symbol: 'ETH-USD', type: 'crypto', name: 'ETH / USD', base: 'ETH', quote: 'USD' },
  { symbol: 'RUB/DKK', type: 'fx', name: 'RUB / DKK', base: 'RUB', quote: 'DKK' },
  { symbol: 'SEK/DKK', type: 'fx', name: 'SEK / DKK', base: 'SEK', quote: 'DKK' },
];

export type WatchTickerOutcome =
  | { readonly status: 'ok'; readonly ticker: WatchTicker; readonly fetchedAt: number }
  | { readonly status: 'unavailable'; readonly reason: MarketUnavailableReason };
export type WatchSeriesOutcome =
  | { readonly status: 'ok'; readonly series: MarketSeries; readonly fetchedAt: number }
  | { readonly status: 'unavailable'; readonly reason: MarketUnavailableReason };

/** One adapter per kind. `fetchedAt` is ours; anything unusable is a typed refusal, never a value. */
export interface WatchAdapter {
  ticker(item: WatchItem): Promise<WatchTickerOutcome>;
  series(item: WatchItem, range: DashboardRange): Promise<WatchSeriesOutcome>;
}

export interface WatchAdapterDeps {
  readonly fetch: typeof fetch;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Test seam for the abort timer. */
  readonly timeoutMs?: number;
}

export interface WatchlistSource {
  readonly items: readonly WatchItem[];
  ticker(item: WatchItem): Promise<WatchTickerOutcome>;
  series(item: WatchItem, range: DashboardRange): Promise<WatchSeriesOutcome>;
}

export interface WatchlistSourceDeps extends WatchAdapterDeps {
  /** Defaults to the shipped WATCHLIST. */
  readonly items?: readonly WatchItem[];
}

/** fx reference rates move at most once a day, so they are cached well past the 60-second crypto ticker. */
export const FX_TICKER_TTL_MS = 10 * 60_000;
export const FX_SERIES_TTL_MS: Record<DashboardRange, number> = { '1W': 60 * 60_000, '1M': 3 * 60 * 60_000, '3M': 6 * 60 * 60_000, '1Y': 12 * 60 * 60_000 };
export const WATCH_TICKER_TTL_MS: Record<WatchItemType, number> = { crypto: TICKER_TTL_MS, fx: FX_TICKER_TTL_MS };
export const WATCH_SERIES_TTL_MS: Record<WatchItemType, Record<DashboardRange, number>> = { crypto: SERIES_TTL_MS, fx: FX_SERIES_TTL_MS };

const DAY_SECONDS = 86_400;

type ReadResult = { ok: true; text: string } | { ok: false; reason: MarketUnavailableReason };
const readText = (deps: WatchAdapterDeps, url: string, headers: HeadersInit, decode?: (bytes: Uint8Array) => string): Promise<ReadResult> => {
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const options: BoundedTextOptions = decode ? { timeoutMs, headers, decode } : { timeoutMs, headers };
  return readBoundedText(deps.fetch, url, options);
};

const parseJson = (text: string): unknown | null => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

// ---- crypto: Coinbase, generalized from market.ts from the fixed BTC-USD product to any configured symbol ----

const COINBASE_PRODUCT = /^[A-Z0-9]{2,15}-[A-Z0-9]{2,15}$/;

const coinbaseParts = (item: WatchItem): { base: string; quote: string } | null => {
  const [base = '', quote = ''] = item.symbol.split('-');
  const named = { base: item.base ?? base, quote: item.quote ?? quote };
  return named.base && named.quote ? named : null;
};

export function createCryptoAdapter(deps: WatchAdapterDeps): WatchAdapter {
  return {
    async ticker(item) {
      if (!COINBASE_PRODUCT.test(item.symbol)) return { status: 'unavailable', reason: 'malformed' };
      const parts = coinbaseParts(item);
      if (!parts) return { status: 'unavailable', reason: 'malformed' };
      const res = await readText(deps, tickerUrl(item.symbol), MARKET_HEADERS);
      if (!res.ok) return { status: 'unavailable', reason: res.reason };
      const ticker = parseCoinbaseTicker(parseJson(res.text), parts.base, parts.quote);
      return ticker ? { status: 'ok', ticker, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
    },
    async series(item, range) {
      if (!COINBASE_PRODUCT.test(item.symbol)) return { status: 'unavailable', reason: 'malformed' };
      const { granularitySeconds, spanSeconds } = DASHBOARD_RANGE_PLAN[range];
      const endSec = Math.floor(deps.now() / 1000 / granularitySeconds) * granularitySeconds;
      const startSec = endSec - spanSeconds;
      const res = await readCandleRows(deps.fetch, range, startSec, endSec, item.symbol, deps.timeoutMs ?? FETCH_TIMEOUT_MS);
      if (!res.ok) return { status: 'unavailable', reason: res.reason };
      const series = parseCandles(res.rows, range, startSec, endSec);
      return series ? { status: 'ok', series, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
    },
  };
}

// ---- fx: Frankfurter (ECB reference rates) and, for RUB which Frankfurter dropped in 2022, Bank of Russia XML ----

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';
const FRANKFURTER_HEADERS = { Accept: 'application/json', 'User-Agent': 'vault-companion' } as const;

const CBR_BASE_URL = 'https://www.cbr.ru/scripts/XML_dynamic.asp';
const CBR_DKK_ID = 'R01215';
const CBR_HEADERS = { Accept: 'application/xml, text/xml, */*', 'User-Agent': 'vault-companion' } as const;

const CURRENCY = /^[A-Z]{3}$/;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const cbrDay = (iso: string): string => {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
};

/** `text/xml` from CBR is windows-1251; decoded here so a wrong default (UTF-8) is a broken guard, not a silent guess. */
export const decodeCbr = (bytes: Uint8Array): string => new TextDecoder('windows-1251').decode(bytes);

const frankfurterLatestUrl = (base: string, quote: string): string => `${FRANKFURTER_BASE}/latest?base=${base}&symbols=${quote}`;
const frankfurterSeriesUrl = (base: string, quote: string, startSec: number, endSec: number): string =>
  `${FRANKFURTER_BASE}/${isoDay(startSec)}..${isoDay(endSec)}?base=${base}&symbols=${quote}`;
const cbrUrl = (startSec: number, endSec: number): string =>
  `${CBR_BASE_URL}?date_req1=${cbrDay(isoDay(startSec))}&date_req2=${cbrDay(isoDay(endSec))}&VAL_NM_RQ=${CBR_DKK_ID}`;

const fxParts = (item: WatchItem): { base: string; quote: string } | null => {
  const [base = '', quote = ''] = item.symbol.split('/');
  const named = { base: item.base ?? base, quote: item.quote ?? quote };
  return named.base && named.quote ? named : null;
};

/** The fx window ends after today (UTC) so today's reference rate is included, and is aligned to whole days. */
const fxWindow = (nowMs: number, range: DashboardRange): { startSec: number; endSec: number } => {
  const nowSec = Math.floor(nowMs / 1000);
  const endSec = Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS + DAY_SECONDS;
  return { startSec: endSec - DASHBOARD_RANGE_PLAN[range].spanSeconds, endSec };
};

const dailyRow = (isoDate: string, price: number): unknown[] => {
  const seconds = Date.parse(`${isoDate}T00:00:00Z`) / 1000;
  const value = String(price);
  return [seconds, value, value, value, value, '0'];
};

/** Frankfurter latest: `{ date, rates: { DKK: 0.68 } }`. A missing rate or date is refused, never defaulted. */
export function parseFrankfurterLatest(body: unknown, base: string, quote: string): WatchTicker | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const date = typeof raw.date === 'string' && DATE_ISO.test(raw.date) ? raw.date : null;
  const rates = raw.rates;
  const rate = typeof rates === 'object' && rates !== null ? Number((rates as Record<string, unknown>)[quote]) : NaN;
  if (!date || !Number.isFinite(rate) || rate <= 0) return null;
  return { base, quote, provider: 'frankfurter', price: rate, providerTime: `${date}T00:00:00Z` };
}

/** Frankfurter time series: `rates` is `{ 'YYYY-MM-DD': { DKK: n } }`; weekend/holiday gaps are left as gaps. */
export function parseFrankfurterSeries(body: unknown, quote: string, range: DashboardRange, startSec: number, endSec: number): MarketSeries | null {
  if (typeof body !== 'object' || body === null) return null;
  const rates = (body as Record<string, unknown>).rates;
  if (typeof rates !== 'object' || rates === null) return null;
  const rows: unknown[] = [];
  for (const [date, value] of Object.entries(rates as Record<string, unknown>)) {
    if (!DATE_ISO.test(date)) continue;
    const rate = typeof value === 'object' && value !== null ? Number((value as Record<string, unknown>)[quote]) : NaN;
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rows.push(dailyRow(date, rate));
  }
  if (rows.length === 0) return null;
  return parseCandles(rows, range, startSec, endSec, DAY_SECONDS);
}

export interface CbrRecord {
  /** ISO `YYYY-MM-DD` (UTC midnight). */
  readonly date: string;
  readonly nominal: number;
  /** RUB per `nominal` DKK, exactly as the provider states it. */
  readonly value: number;
}

/** CBR quotes RUB per `nominal` DKK, but the card is "RUB / DKK", so we invert to DKK per 1 RUB. */
export const dkkPerRub = (record: CbrRecord): number => record.nominal / record.value;

/**
 * Bank of Russia XML_dynamic: `<Record Date="01.09.2026"><Nominal>1</Nominal><Value>13,4547</Value></Record>`.
 * Comma decimals are parsed; records we cannot read are dropped. A document that is not CBR's root is refused outright.
 */
export function parseCbrRecords(xml: string): CbrRecord[] | null {
  if (!/<ValCurs\b/.test(xml)) return null;
  const out: CbrRecord[] = [];
  const record = /<Record\b([^>]*)>([\s\S]*?)<\/Record>/g;
  for (let match = record.exec(xml); match; match = record.exec(xml)) {
    const date = /\bDate="(\d{2})\.(\d{2})\.(\d{4})"/.exec(match[1] ?? '');
    const nominal = /<Nominal>\s*([^<]+?)\s*<\/Nominal>/.exec(match[2] ?? '');
    const value = /<Value>\s*([^<]+?)\s*<\/Value>/.exec(match[2] ?? '');
    if (!date?.[1] || !date[2] || !date[3] || !nominal?.[1] || !value?.[1]) continue;
    const seconds = Date.UTC(Number(date[3]), Number(date[2]) - 1, Number(date[1])) / 1000;
    const nominalN = Number(nominal[1].replace(',', '.'));
    const valueN = Number(value[1].replace(',', '.'));
    if (!Number.isFinite(seconds) || !Number.isFinite(nominalN) || !Number.isFinite(valueN) || nominalN <= 0 || valueN <= 0) continue;
    out.push({ date: isoDay(seconds), nominal: nominalN, value: valueN });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** Latest = the last record in the requested window; empty records are refused, never guessed. */
export function cbrTicker(records: readonly CbrRecord[], base: string, quote: string): WatchTicker | null {
  const last = records[records.length - 1];
  if (!last) return null;
  const price = dkkPerRub(last);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { base, quote, provider: 'cbr', price, providerTime: `${last.date}T00:00:00Z` };
}

export function createFxAdapter(deps: WatchAdapterDeps): WatchAdapter {
  const readCbr = (url: string): Promise<ReadResult> => readText(deps, url, CBR_HEADERS, decodeCbr);

  const cbrRecords = async (url: string): Promise<CbrRecord[] | null> => {
    const res = await readCbr(url);
    if (!res.ok) return null;
    return parseCbrRecords(res.text);
  };

  const usable = (item: WatchItem): { base: string; quote: string } | null => {
    const parts = fxParts(item);
    return parts && CURRENCY.test(parts.base) && CURRENCY.test(parts.quote) ? parts : null;
  };

  return {
    async ticker(item) {
      const parts = usable(item);
      if (!parts) return { status: 'unavailable', reason: 'malformed' };
      const { base, quote } = parts;
      if (base === 'RUB') {
        if (quote !== 'DKK') return { status: 'unavailable', reason: 'malformed' };
        const { endSec } = fxWindow(deps.now(), '1W');
        const records = await cbrRecords(cbrUrl(endSec - 14 * DAY_SECONDS, endSec - DAY_SECONDS));
        if (!records || records.length === 0) return { status: 'unavailable', reason: 'malformed' };
        const ticker = cbrTicker(records, base, quote);
        return ticker ? { status: 'ok', ticker, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
      }
      const res = await readText(deps, frankfurterLatestUrl(base, quote), FRANKFURTER_HEADERS);
      if (!res.ok) return { status: 'unavailable', reason: res.reason };
      const ticker = parseFrankfurterLatest(parseJson(res.text), base, quote);
      return ticker ? { status: 'ok', ticker, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
    },
    async series(item, range) {
      const parts = usable(item);
      if (!parts) return { status: 'unavailable', reason: 'malformed' };
      const { base, quote } = parts;
      const { startSec, endSec } = fxWindow(deps.now(), range);
      if (base === 'RUB') {
        if (quote !== 'DKK') return { status: 'unavailable', reason: 'malformed' };
        const records = await cbrRecords(cbrUrl(startSec, endSec - DAY_SECONDS));
        if (!records || records.length === 0) return { status: 'unavailable', reason: 'malformed' };
        const rows = records.map((record) => dailyRow(record.date, dkkPerRub(record)));
        const series = parseCandles(rows, range, startSec, endSec, DAY_SECONDS);
        return series ? { status: 'ok', series, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
      }
      const res = await readText(deps, frankfurterSeriesUrl(base, quote, startSec, endSec - DAY_SECONDS), FRANKFURTER_HEADERS);
      if (!res.ok) return { status: 'unavailable', reason: res.reason };
      const series = parseFrankfurterSeries(parseJson(res.text), quote, range, startSec, endSec);
      return series ? { status: 'ok', series, fetchedAt: deps.now() } : { status: 'unavailable', reason: 'malformed' };
    },
  };
}

const adapterUnavailableTicker: WatchTickerOutcome = { status: 'unavailable', reason: 'provider-error' };
const adapterUnavailableSeries: WatchSeriesOutcome = { status: 'unavailable', reason: 'provider-error' };

/** Per-item, per-type TTL caches; a failed refresh falls back to last-known data with its ORIGINAL fetchedAt. */
export function createWatchlistSource(deps: WatchlistSourceDeps): WatchlistSource {
  const items = deps.items ?? WATCHLIST;
  const adapters: Record<WatchItemType, WatchAdapter> = { crypto: createCryptoAdapter(deps), fx: createFxAdapter(deps) };
  const tickerCache = new Map<string, { fetchedAt: number; outcome: Extract<WatchTickerOutcome, { status: 'ok' }> }>();
  const seriesCache = new Map<string, { fetchedAt: number; outcome: Extract<WatchSeriesOutcome, { status: 'ok' }> }>();
  const tickerInflight = new Map<string, Promise<WatchTickerOutcome>>();
  const seriesInflight = new Map<string, Promise<WatchSeriesOutcome>>();
  const itemKey = (item: WatchItem): string => `${item.type}:${item.symbol}`;

  return {
    items,
    async ticker(item) {
      const key = itemKey(item);
      const cached = tickerCache.get(key);
      if (cached && deps.now() - cached.fetchedAt < WATCH_TICKER_TTL_MS[item.type]) return cached.outcome;
      let inflight = tickerInflight.get(key);
      if (!inflight) {
        inflight = adapters[item.type]
          .ticker(item)
          .catch((): WatchTickerOutcome => adapterUnavailableTicker)
          .finally(() => tickerInflight.delete(key));
        tickerInflight.set(key, inflight);
      }
      const fresh = await inflight;
      if (fresh.status === 'ok') {
        tickerCache.set(key, { fetchedAt: fresh.fetchedAt, outcome: fresh });
        return fresh;
      }
      // Visible stale: the old value keeps its original fetchedAt, so it is never repainted as current.
      return cached ? cached.outcome : fresh;
    },
    async series(item, range) {
      const key = `${itemKey(item)}:${range}`;
      const cached = seriesCache.get(key);
      if (cached && deps.now() - cached.fetchedAt < WATCH_SERIES_TTL_MS[item.type][range]) return cached.outcome;
      let inflight = seriesInflight.get(key);
      if (!inflight) {
        inflight = adapters[item.type]
          .series(item, range)
          .catch((): WatchSeriesOutcome => adapterUnavailableSeries)
          .finally(() => seriesInflight.delete(key));
        seriesInflight.set(key, inflight);
      }
      const fresh = await inflight;
      if (fresh.status === 'ok') {
        seriesCache.set(key, { fetchedAt: fresh.fetchedAt, outcome: fresh });
        return fresh;
      }
      return cached ? cached.outcome : fresh;
    },
  };
}
