import type { MarketCard, MarketSeries, WatchCard } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { formatChange, formatWatchPrice, legacyMarketCard, seriesChange, watchCards, watchDecimals, watchFresh, watchTitle } from './watchlist.ts';

const NOW = '2026-09-30T12:00:00Z';
const point = (index: number, close: number) => ({
  time: new Date(Date.parse(NOW) - (2 - index) * 3_600_000).toISOString(), open: close, high: close, low: close, close,
});
const series = (closes: readonly number[]): MarketSeries =>
  ({ range: '1W', granularitySeconds: 3_600, points: closes.map((close, index) => point(index, close)), missingIntervals: 0 });

const fx = (over: Record<string, unknown> = {}): WatchCard => ({
  id: 'watchlist', status: 'ok', title: 'RUB / DKK', provenance: 'Frankfurter (ECB reference rates)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, item: { symbol: 'RUB/DKK', type: 'fx' },
  ticker: { base: 'RUB', quote: 'DKK', provider: 'frankfurter', price: 0.0712, providerTime: NOW },
  series: series([0.07, 0.0712]), ...over,
} as WatchCard);
const crypto = (over: Record<string, unknown> = {}): WatchCard => ({
  id: 'watchlist', status: 'ok', title: 'ETH / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, item: { symbol: 'ETH-USD', type: 'crypto' },
  ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 3123.4, providerTime: NOW },
  series: series([3_000, 3_123.4]), ...over,
} as WatchCard);
const unavailable: WatchCard = {
  id: 'watchlist', status: 'unavailable', title: 'ignored', provenance: 'Bank of Russia',
  observedAt: null, fetchedAt: null, note: 'The market provider is unavailable right now.', drillthrough: null,
  item: { symbol: 'RUB/DKK', type: 'fx' }, reason: 'provider-error',
};
const market: MarketCard = {
  id: 'market', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null,
  ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60_000, providerTime: NOW }, series: series([60_000, 60_100]),
};

describe('watchlist selection (WL2)', () => {
  it('lists every watchlist card and hides the legacy market card only while they exist', () => {
    expect(watchCards([market, fx(), crypto()])).toEqual([fx(), crypto()]);
    expect(legacyMarketCard([market])).toBe(market);
    expect(legacyMarketCard([market, fx()])).toBeNull();
  });

  it('titles a card from item/ticker base/quote, even when the title field disagrees', () => {
    expect(watchTitle(crypto({ title: 'ignored' }))).toBe('ETH / USD');
    expect(watchTitle(fx({ title: 'ignored' }))).toBe('RUB / DKK');
    expect(watchTitle(unavailable)).toBe('RUB / DKK'); // no ticker: the symbol is split on its separator
  });
});

describe('watchlist price (WL2)', () => {
  it('quotes fx to four decimals and crypto to two, in the quote currency', () => {
    expect(watchDecimals(fx())).toBe(4);
    expect(watchDecimals(crypto())).toBe(2);
    expect(formatWatchPrice(fx())).toBe('DKK 0.0712');
    expect(formatWatchPrice(crypto())).toBe('$3,123.40');
  });

  it('never paints a number for an unavailable card', () => {
    expect(formatWatchPrice(unavailable)).toBe('');
  });
});

describe('watchlist change over the range (WL2)', () => {
  it('keeps the sign: a rise is positive, a fall is negative', () => {
    expect(seriesChange(series([100, 110]))).toEqual({ direction: 'up', percent: 10 });
    expect(formatChange(seriesChange(series([100, 110]))!)).toBe('+10.00%');
    expect(seriesChange(series([100, 90]))).toEqual({ direction: 'down', percent: -10 });
    expect(formatChange(seriesChange(series([100, 90]))!)).toBe('-10.00%');
  });

  it('has no change when there is no history to measure', () => {
    expect(seriesChange(null)).toBeNull();
    expect(seriesChange(series([100]))).toBeNull();
  });
});

describe('watchlist freshness (WL2)', () => {
  it('is fresh inside the window and stale outside it', () => {
    expect(watchFresh(fx(), Date.parse(NOW) + 1_000, 120_000)).toBe(true);
    expect(watchFresh(fx(), Date.parse(NOW) + 200_000, 120_000)).toBe(false);
    expect(watchFresh(unavailable, Date.parse(NOW), 120_000)).toBe(false); // nothing was fetched
  });
});