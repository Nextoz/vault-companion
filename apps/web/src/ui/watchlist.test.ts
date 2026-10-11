import type { MarketCard, MarketSeries, PrivateValuationCard, WatchCard } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { formatChange, formatPrivateValuation, formatWatchPrice, formatWatchValue, legacyMarketCard, privateValuationCards, privateValuationUnavailableReason, seriesChange, watchCards, watchDecimals, watchDelayLabel, watchFresh, watchTitle } from './watchlist.ts';

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
const stock = (over: Record<string, unknown> = {}): WatchCard => ({
  id: 'watchlist', status: 'ok', title: 'NVIDIA', provenance: 'Yahoo Finance',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, item: { symbol: 'NVDA', type: 'stock' },
  ticker: { base: 'NVDA', quote: 'USD', provider: 'Yahoo Finance', price: 229.28, providerTime: NOW },
  series: series([183.16, 229.28]), ...over,
} as WatchCard);
const downStock: WatchCard = {
  id: 'watchlist', status: 'unavailable', title: 'SpaceX', provenance: 'Yahoo Finance',
  observedAt: null, fetchedAt: null, note: 'The market provider is unavailable right now.', drillthrough: null,
  item: { symbol: 'SPCX', type: 'stock' }, reason: 'provider-error',
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

  it('names a stock by its company and symbol, and marks only stocks delayed (WL4a)', () => {
    expect(watchTitle(stock())).toBe('NVIDIA (NVDA)');
    expect(watchTitle(downStock)).toBe('SpaceX (SPCX)');
    expect(watchDelayLabel(stock())).toBe('Delayed');
    expect(watchDelayLabel(downStock)).toBe('Delayed');
    expect(watchDelayLabel(crypto())).toBeNull();
    expect(watchDelayLabel(fx())).toBeNull();
  });
});

describe('watchlist price (WL2)', () => {
  it('quotes fx to four decimals and crypto to two, in the quote currency', () => {
    expect(watchDecimals(fx())).toBe(4);
    expect(watchDecimals(crypto())).toBe(2);
    expect(watchDecimals(stock())).toBe(2);
    expect(formatWatchPrice(fx())).toBe('DKK 0.0712');
    expect(formatWatchPrice(crypto())).toBe('$3,123.40');
    expect(formatWatchPrice(stock())).toBe('$229.28');
  });

  it('never paints a number for an unavailable card', () => {
    expect(formatWatchPrice(unavailable)).toBe('');
  });

  it('formats any series point with the same quote and precision (the chart readout)', () => {
    expect(formatWatchValue(fx(), 0.09)).toBe('DKK 0.0900');
    expect(formatWatchValue(crypto(), 2_900)).toBe('$2,900.00');
    expect(formatWatchValue(unavailable, 1)).toBe('');
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

  it('measures a 1Y series the same way as any other range (WL3)', () => {
    const year: MarketSeries = { ...series([100, 90]), range: '1Y' };
    expect(seriesChange(year)).toEqual({ direction: 'down', percent: -10 });
    expect(formatChange(seriesChange(year)!)).toBe('-10.00%');
  });
});

describe('watchlist freshness (WL2)', () => {
  it('is fresh inside the window and stale outside it', () => {
    expect(watchFresh(fx(), Date.parse(NOW) + 1_000, 120_000)).toBe(true);
    expect(watchFresh(fx(), Date.parse(NOW) + 200_000, 120_000)).toBe(false);
    expect(watchFresh(unavailable, Date.parse(NOW), 120_000)).toBe(false); // nothing was fetched
  });
});

describe('private valuations (WL4b)', () => {
  const privateOk = (over: Record<string, unknown> = {}): PrivateValuationCard => ({
    id: 'private-valuation', status: 'ok', title: 'OpenAI', provenance: 'Vault: Automation/Watchlist/private-valuations.json',
    observedAt: null, fetchedAt: NOW, note: null, drillthrough: null,
    item: { id: 'openai', name: 'OpenAI', valueUsdBillions: 500, asOf: '2026-03-12', source: { label: 'Synthetic round report', url: 'https://example.test/openai-round' } },
    ...over,
  } as PrivateValuationCard);
  const privateDown: PrivateValuationCard = {
    id: 'private-valuation', status: 'unavailable', title: 'Private valuations', provenance: 'Vault: Automation/Watchlist/private-valuations.json',
    observedAt: null, fetchedAt: null, note: 'No private-valuation file exists yet.', drillthrough: null, reason: 'not-found',
  };

  it('labels the line "private", with the ~USD figure and the date, and never a market price', () => {
    expect(formatPrivateValuation(privateOk())).toBe('private · last round ~USD 500 B · 12 Mar 2026');
    expect(formatPrivateValuation(privateOk())).toContain('private');
    expect(formatPrivateValuation(privateOk({ item: { id: 'x', name: 'x', valueUsdBillions: 12.5, asOf: '2025-11-01', source: { label: 'x', url: 'https://example.test/x' } } }))).toBe('private · last round ~USD 12.5 B · 01 Nov 2025');
    expect(formatPrivateValuation(privateOk())).not.toMatch(/\$|Delayed/);
  });

  it('selects only private-valuation cards, in arrival order', () => {
    expect(privateValuationCards([market, privateOk(), privateDown, fx()])).toEqual([privateOk(), privateDown]);
    expect(privateValuationCards([market, fx()])).toEqual([]);
  });

  it('has no figure for an unavailable card, only its fixed plain reason', () => {
    expect(formatPrivateValuation(privateDown)).toBe('');
    expect(privateValuationUnavailableReason(privateDown)).toBe('not-found');
    expect(privateValuationUnavailableReason(privateOk())).toBeNull();
    expect(privateValuationUnavailableReason({ ...privateDown, reason: 'invalid' })).toBe('invalid');
  });
});
