import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_RANGE_PLAN,
  DASHBOARD_RANGES,
  DashboardResponse,
  MAX_MARKET_POINTS,
  MarketTickerResponse,
  type DashboardCard,
  type MarketPoint,
} from './index.ts';

const NOW = '2026-09-30T12:00:00Z';
const at = (i: number) => new Date(Date.parse(NOW) - i * 3_600_000).toISOString();
const point = (i: number): MarketPoint => ({ time: at(i), open: 60_000 + i, high: 60_100 + i, low: 59_900 + i, close: 60_050 + i });

const card = (over: Partial<DashboardCard> = {}): DashboardCard => ({
  id: 'market', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null,
  ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60_000, providerTime: NOW },
  series: { range: '1W', granularitySeconds: 3_600, points: [point(0), point(1)], missingIntervals: 0 },
  ...over,
} as DashboardCard);

describe('DashboardResponse (DASH1)', () => {
  it('accepts the market card plus honest non-ok overview cards, and allows an absent history', () => {
    const parsed = DashboardResponse.parse({
      now: NOW,
      cards: [
        card({ series: null }),
        { id: 'ai-usage', status: 'not-configured', title: 'AI usage', provenance: 'Not configured', observedAt: null, fetchedAt: null, note: 'No approved usage source.', drillthrough: null },
        { id: 'health', status: 'unavailable', title: 'Health', provenance: 'Not configured', observedAt: null, fetchedAt: null, note: 'No approved health source.', drillthrough: null },
      ],
    });
    expect(parsed.cards).toHaveLength(3);
    expect(parsed.cards[0]).toMatchObject({ id: 'market', status: 'ok', series: null });
  });

  it('keeps a drillthrough seam that carries a label and a view token', () => {
    const parsed = DashboardResponse.parse({
      now: NOW,
      cards: [card({ drillthrough: { label: 'Markets', view: 'markets' } })],
    });
    expect(parsed.cards[0]!.drillthrough).toEqual({ label: 'Markets', view: 'markets' });
  });

  // Production guard-negative: the point cap is a real bound, not decoration.
  it('rejects more than MAX_MARKET_POINTS buckets (the 300-point cap)', () => {
    const points = Array.from({ length: MAX_MARKET_POINTS + 1 }, (_, i) => point(i));
    const bad = { now: NOW, cards: [card({ series: { range: '3M', granularitySeconds: 86_400, points, missingIntervals: 0 } as never })] };
    expect(DashboardResponse.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown range and an unknown provider', () => {
    const series = card() as Extract<DashboardCard, { id: 'market'; status: 'ok' }>;
    const badRange = { ...series, series: { ...series.series!, range: '2Y' } };
    const badProvider = { ...series, ticker: { ...series.ticker, provider: 'binance' } };
    expect(DashboardResponse.safeParse({ now: NOW, cards: [badRange] }).success).toBe(false);
    expect(DashboardResponse.safeParse({ now: NOW, cards: [badProvider] }).success).toBe(false);
  });

  it('rejects an unknown market failure reason', () => {
    const bad = { id: 'market', status: 'unavailable', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)', observedAt: null, fetchedAt: null, note: 'x', drillthrough: null, reason: 'rate-limited' };
    expect(DashboardResponse.safeParse({ now: NOW, cards: [bad] }).success).toBe(false);
  });
});

describe('MarketTickerResponse (DASH1 ticker poll)', () => {
  it('carries the current value and its own fetchedAt', () => {
    const ok = MarketTickerResponse.parse({ status: 'ok', now: NOW, ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60_000, providerTime: NOW }, fetchedAt: NOW });
    expect(ok.status).toBe('ok');
    const down = MarketTickerResponse.parse({ status: 'unavailable', now: NOW, reason: 'timeout' });
    expect(down.status).toBe('unavailable');
  });
});

describe('DASHBOARD_RANGE_PLAN', () => {
  it('keeps every range inside the series point cap', () => {
    for (const plan of Object.values(DASHBOARD_RANGE_PLAN)) {
      expect(plan.spanSeconds / plan.granularitySeconds).toBeLessThanOrEqual(MAX_MARKET_POINTS);
    }
  });

  // Production guard: 1Y is a real year of daily buckets, not a relabelled 3M, and it fits the series cap.
  it('defines 1Y as ~365 days of daily buckets within MAX_MARKET_POINTS', () => {
    expect(DASHBOARD_RANGES).toContain('1Y');
    expect(DASHBOARD_RANGE_PLAN['1Y']).toEqual({ granularitySeconds: 86_400, spanSeconds: 365 * 86_400 });
    expect(DASHBOARD_RANGE_PLAN['1Y'].spanSeconds / DASHBOARD_RANGE_PLAN['1Y'].granularitySeconds).toBeLessThanOrEqual(MAX_MARKET_POINTS);
  });
});
