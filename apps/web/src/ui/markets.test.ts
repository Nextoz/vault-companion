// W1b (markets tests): one test per numbered rule of the Markets row model, so a broken rule fails by name.
// Fixtures are synthetic; no DOM, no fetching — the row model is pure.
import type { MarketCard, MarketSeries, PrivateValuationCard, WatchCard } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { type MarketRow, type MarketsInput, formatPrivateAmount, marketRows, marketsSummary } from './markets.ts';

const NOW = '2026-09-30T12:00:00Z';
const TICKER = { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60_123.45, providerTime: NOW };

const point = (index: number, close: number) => ({
  time: new Date(Date.parse(NOW) - (1 - index) * 3_600_000).toISOString(), open: close, high: close, low: close, close,
});
const seriesOf = (closes: readonly number[]): MarketSeries => ({
  range: '1W' as const, granularitySeconds: 3_600, points: closes.map((close, index) => point(index, close)), missingIntervals: 0,
});

const market = (over: Record<string, unknown> = {}): MarketCard => ({
  id: 'market', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, ticker: TICKER, series: seriesOf([50, 100]),
  ...over,
} as MarketCard);

const watch = (over: Record<string, unknown> = {}): WatchCard => ({
  id: 'watchlist', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null,
  item: { symbol: 'BTC-USD', type: 'crypto' }, ticker: TICKER, series: seriesOf([50, 100]),
  ...over,
} as WatchCard);

const privateCard = (over: Record<string, unknown> = {}): PrivateValuationCard => ({
  id: 'private-valuation', status: 'ok', title: 'SpaceX', provenance: 'Vault: companies.md',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null,
  item: { id: 'spacex', name: 'SpaceX', valueUsdBillions: 500, asOf: '2026-03-12', source: { label: 'CNBC', url: 'https://example.com/spacex' } },
  ...over,
} as PrivateValuationCard);

const rows = (over: Partial<MarketsInput> = {}): MarketRow[] =>
  marketRows({ market: null, watches: [], privates: [], isStale: () => false, ...over });

const priced = (row: MarketRow): Extract<MarketRow, { kind: 'priced' }> => {
  if (row.kind !== 'priced') throw new Error(`expected a priced row, got ${row.kind}`);
  return row;
};

describe('marketRows', () => {
  it('rule 1: legacy market card first (when present), then watches in order, then privates in order', () => {
    const eth = watch({ item: { symbol: 'ETH-USD', type: 'crypto' }, ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 3_210.5, providerTime: NOW } });
    const eur = watch({ item: { symbol: 'EUR-USD', type: 'fx' }, ticker: { base: 'EUR', quote: 'USD', provider: 'ECB', price: 0.6789, providerTime: NOW } });
    const neuralink = privateCard({ title: 'Neuralink', item: { id: 'neuralink', name: 'Neuralink', valueUsdBillions: 2.1, asOf: '2026-03-12', source: { label: 'Reuters', url: 'https://example.com/neuralink' } } });
    const out = rows({ market: market(), watches: [eth, eur], privates: [privateCard(), neuralink] });
    expect(out.map((row) => row.key)).toEqual(['market', 'watch:ETH-USD', 'watch:EUR-USD', 'private:spacex', 'private:neuralink']);
    expect(rows({ watches: [eth, eur], privates: [neuralink] }).map((row) => row.kind)).toEqual(['priced', 'priced', 'private']);
  });

  it('rule 2: an unavailable card is a bare row — no price, no series, no change, never an old number', () => {
    const out = rows({ market: market({ status: 'unavailable', reason: 'malformed' }), watches: [
      watch({ status: 'unavailable', reason: 'timeout' }),
      watch({ status: 'unavailable', reason: 'provider-error', item: { symbol: 'ETH-USD', type: 'crypto' } }),
    ] });
    expect(out.map((row) => row.kind)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    expect(out.map((row) => row.key)).toEqual(['unavailable:0', 'unavailable:1', 'unavailable:2']);
    expect(out[0]!.label).toBe('BTC / USD');
    const bare = out[1]!;
    expect(bare.label).toBe('BTC-USD');
    expect('priceText' in bare).toBe(false);
    expect('series' in bare).toBe(false);
    expect('change' in bare).toBe(false);
    expect('stale' in bare).toBe(false);
    expect('amountText' in bare).toBe(false);
  });

  it('rule 3: the legacy market row is exact — base label, $ two-decimal USD price, series, change, staleness, key', () => {
    const cardSeries = seriesOf([50, 100]);
    const card = market({ ticker: { ...TICKER, price: 60_000.5 }, series: cardSeries });
    expect(rows({ market: card, isStale: () => true })).toEqual([{
      kind: 'priced', key: 'market', label: 'BTC', priceText: '$60,000.50',
      change: { direction: 'up', percent: 100 }, series: cardSeries, stale: true, card,
    }]);
  });

  it('rule 3: labels by kind — stock symbol, crypto base, fx base/quote', () => {
    const stock = watch({ item: { symbol: 'NVDA', type: 'stock' }, ticker: { base: 'NVDA', quote: 'USD', provider: 'Yahoo', price: 121.75, providerTime: NOW } });
    const fx = watch({ item: { symbol: 'EUR-USD', type: 'fx' }, ticker: { base: 'EUR', quote: 'USD', provider: 'ECB', price: 0.6789, providerTime: NOW } });
    expect(rows({ watches: [stock, watch(), fx] }).map((row) => row.label)).toEqual(['NVDA', 'BTC', 'EUR/USD']);
  });

  it('rule 3: watch price text follows the quote, series is the card series, change is computed from it or absent', () => {
    const cryptoSeries = seriesOf([50, 100]);
    const crypto = watch({ series: cryptoSeries });
    const fx = watch({ item: { symbol: 'EUR-USD', type: 'fx' }, ticker: { base: 'EUR', quote: 'USD', provider: 'ECB', price: 0.6789, providerTime: NOW }, series: seriesOf([100, 50]) });
    const noHistory = watch({ series: null });
    const out = rows({ watches: [crypto, fx, noHistory] });
    expect(out[0]).toMatchObject({ kind: 'priced', key: 'watch:BTC-USD', priceText: '$60,123.45', change: { direction: 'up', percent: 100 }, stale: false, card: crypto });
    expect(priced(out[0]!).series).toBe(cryptoSeries);
    expect(out[1]).toMatchObject({ key: 'watch:EUR-USD', priceText: '$0.6789', change: { direction: 'down', percent: -50 } });
    expect(out[2]).toMatchObject({ key: 'watch:BTC-USD', priceText: '$60,123.45', change: null, series: null });
  });

  it('rule 3: a row is stale exactly when isStale says so, per card', () => {
    const stale = watch({ item: { symbol: 'ETH-USD', type: 'crypto' }, ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 3_210.5, providerTime: NOW } });
    const out = rows({ watches: [stale, watch()], isStale: (card) => card === stale });
    expect(out.map((row) => (row.kind === 'priced' ? row.stale : null))).toEqual([true, false]);
  });

  it('rule 4: private rows show the card title and the formatted last-round figure; unavailable privates are bare', () => {
    const ok = privateCard({ title: 'Neuralink · Series E', item: { id: 'neuralink', name: 'Neuralink', valueUsdBillions: 2.1, asOf: '2026-03-12', source: { label: 'Reuters', url: 'https://example.com/neuralink' } } });
    const missing = privateCard({ title: 'OpenAI', status: 'unavailable', reason: 'not-found' });
    const out = rows({ privates: [ok, missing] });
    expect(out[0]).toEqual({ kind: 'private', key: 'private:neuralink', label: 'Neuralink · Series E', amountText: '$2.1 B', card: ok });
    expect(out[1]!.kind).toBe('unavailable');
    expect(out[1]!.key).toBe('unavailable:1');
    expect(out[1]!.label).toBe('OpenAI');
    expect('amountText' in out[1]!).toBe(false);
  });
});

describe('formatPrivateAmount', () => {
  it('formats billions in USD with at most one decimal, en-US — never a market price', () => {
    expect(formatPrivateAmount(2.1)).toBe('$2.1 B');
    expect(formatPrivateAmount(500)).toBe('$500 B');
    expect(formatPrivateAmount(1_234.56)).toBe('$1,234.6 B');
  });
});

describe('marketsSummary', () => {
  const eth = watch({ item: { symbol: 'ETH-USD', type: 'crypto' }, ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 3_210.5, providerTime: NOW } });
  const four = rows({ market: market(), watches: [eth, watch()], privates: [privateCard()] });

  it('rule 5: summarizes the first two rows only; more is the row count past two, never negative', () => {
    const summary = marketsSummary(four);
    expect(summary.items.map((item) => item.label)).toEqual(['BTC', 'ETH']);
    expect(summary.more).toBe(2);
    const two = marketsSummary(four.slice(0, 2));
    expect(two.items).toHaveLength(2);
    expect(two.more).toBe(0);
    const one = marketsSummary(four.slice(0, 1));
    expect(one.items).toHaveLength(1);
    expect(one.more).toBe(0);
    expect(marketsSummary([])).toEqual({ items: [], more: 0 });
  });

  it('rule 5: a priced row with change reads as the signed percent in its direction tone', () => {
    const up = rows({ market: market() })[0]!;
    const down = rows({ watches: [watch({ series: seriesOf([100, 50]) })] })[0]!;
    expect(marketsSummary([up]).items).toEqual([{ label: 'BTC', text: '+100.00%', tone: 'up' }]);
    expect(marketsSummary([down]).items).toEqual([{ label: 'BTC', text: '-50.00%', tone: 'down' }]);
  });

  it('rule 5: no change falls back to the muted price; private reads last round; unavailable reads unavailable', () => {
    const priced = rows({ watches: [watch({ series: null })] })[0]!;
    const priv = rows({ privates: [privateCard()] })[0]!;
    const bare = rows({ watches: [watch({ status: 'unavailable', reason: 'timeout' })] })[0]!;
    const summary = marketsSummary([priced, priv, bare]);
    expect(summary.items).toEqual([
      { label: 'BTC', text: '$60,123.45', tone: 'muted' },
      { label: 'SpaceX', text: 'last round', tone: 'muted' },
    ]);
    expect(summary.more).toBe(1);
    expect(marketsSummary([bare]).items).toEqual([{ label: 'BTC-USD', text: 'unavailable', tone: 'muted' }]);
  });

  it('rule 5: a stale priced row appends " (stale)" and reads muted, with or without change', () => {
    const withChange = rows({ market: market(), isStale: () => true })[0]!;
    const without = rows({ watches: [watch({ series: null })], isStale: () => true })[0]!;
    expect(marketsSummary([withChange]).items).toEqual([{ label: 'BTC', text: '+100.00% (stale)', tone: 'muted' }]);
    expect(marketsSummary([without]).items).toEqual([{ label: 'BTC', text: '$60,123.45 (stale)', tone: 'muted' }]);
  });
});
