import type { DashboardRange } from '@vault-companion/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildStockSeries, parseYahooQuote } from './stock-quote.ts';

// Captured real responses (synthetic-safe fixtures): NVDA has a full year, SPCX listed 2026-06-12 so its 1y is shorter.
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
const NOW_MS = Date.parse('2026-10-10T12:00:00Z');
const RANGES: readonly DashboardRange[] = ['1W', '1M', '3M', '1Y'];
const EXPECTED: Record<'NVDA' | 'SPCX', Record<DashboardRange, number>> = {
  NVDA: { '1W': 5, '1M': 21, '3M': 64, '1Y': 250 },
  SPCX: { '1W': 5, '1M': 21, '3M': 64, '1Y': 83 },
};

describe('Yahoo chart parser (WL4a)', () => {
  it('reads the captured NVDA response into a USD ticker and a full daily year', () => {
    const quote = parseYahooQuote(fixture('yahoo-NVDA-1y.json'), 'NVDA')!;
    expect(quote.ticker).toEqual({
      base: 'NVDA', quote: 'USD', provider: 'Yahoo Finance', price: 229.28, providerTime: '2026-10-09T20:00:00.000Z',
    });
    expect(quote.daily).toHaveLength(251);
    expect(quote.daily[0]).toEqual({ time: '2025-10-10T13:30:00.000Z', close: 183.16000366210938 });
    expect(quote.daily.at(-1)).toEqual({ time: '2026-10-09T13:30:00.000Z', close: 229.27999877929688 });
  });

  it('builds one series per range from that single daily array, counting provider gaps as missing', () => {
    const quote = parseYahooQuote(fixture('yahoo-NVDA-1y.json'), 'NVDA')!;
    for (const range of RANGES) {
      const series = buildStockSeries(quote, range, NOW_MS)!;
      expect(series.range).toBe(range);
      expect(series.granularitySeconds).toBe(86_400);
      expect(series.points).toHaveLength(EXPECTED.NVDA[range]);
      expect(series.missingIntervals).toBe(Number(range === '1W' ? 7 : range === '1M' ? 30 : range === '3M' ? 90 : 365) - EXPECTED.NVDA[range]);
      expect(series.points.every((point) => point.close > 0)).toBe(true);
    }
  });

  it('renders SPCX with fewer than a year of points, inventing nothing', () => {
    const quote = parseYahooQuote(fixture('yahoo-SPCX-1y.json'), 'SPCX')!;
    const year = buildStockSeries(quote, '1Y', NOW_MS)!;
    expect(year.points).toHaveLength(EXPECTED.SPCX['1Y']); // 83 < a year, no padding
    expect(year.points).toHaveLength(quote.daily.length);
    expect(year.missingIntervals).toBe(365 - 83);
    expect(quote.ticker).toMatchObject({ base: 'SPCX', quote: 'USD', provider: 'Yahoo Finance', price: 162.57 });
  });

  it('skips provider nulls and never zero-fills a close', () => {
    const body = {
      chart: {
        result: [{
          meta: { currency: 'USD', regularMarketPrice: 10, regularMarketTime: 1_700_172_800 },
          timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
          indicators: { quote: [{ close: [9.5, null, 10] }] },
        }],
      },
    };
    const quote = parseYahooQuote(body, 'TEST')!;
    expect(quote.daily.map((day) => day.close)).toEqual([9.5, 10]);
    expect(quote.daily).toHaveLength(2);
  });

  // Production guard-negative: the USD-currency check is a real refusal, not decoration.
  it('refuses a non-USD instrument instead of relabelling its price', () => {
    const eur = { chart: { result: [{ meta: { currency: 'EUR', regularMarketPrice: 10, regularMarketTime: 1_700_000_000 }, timestamp: [1_700_000_000], indicators: { quote: [{ close: [10] }] } }] } };
    expect(parseYahooQuote(eur, 'ASML')).toBeNull();
  });

  it('refuses a missing, zero or non-finite price, and an empty result', () => {
    const withMeta = (meta: Record<string, unknown>) => ({ chart: { result: [{ meta, timestamp: [], indicators: { quote: [{ close: [] }] } }] } });
    expect(parseYahooQuote(withMeta({ currency: 'USD', regularMarketTime: 1_700_000_000 }), 'X')).toBeNull();
    expect(parseYahooQuote(withMeta({ currency: 'USD', regularMarketPrice: 0, regularMarketTime: 1_700_000_000 }), 'X')).toBeNull();
    expect(parseYahooQuote(withMeta({ currency: 'USD', regularMarketPrice: 'n/a', regularMarketTime: 1_700_000_000 }), 'X')).toBeNull();
    expect(parseYahooQuote(withMeta({ currency: 'USD', regularMarketPrice: Number.POSITIVE_INFINITY, regularMarketTime: 1_700_000_000 }), 'X')).toBeNull();
    expect(parseYahooQuote(withMeta({ currency: 'USD', regularMarketPrice: 10, regularMarketTime: 0 }), 'X')).toBeNull();
    expect(parseYahooQuote({ chart: { result: [] } }, 'X')).toBeNull();
    expect(parseYahooQuote(null, 'X')).toBeNull();
    expect(parseYahooQuote({ chart: {} }, 'X')).toBeNull();
  });

  it('has no history for a window the provider did not cover, instead of a flat invented line', () => {
    const quote = parseYahooQuote(fixture('yahoo-SPCX-1y.json'), 'SPCX')!;
    expect(buildStockSeries(quote, '1W', Date.parse('2026-01-01T12:00:00Z'))).toBeNull();
    expect(buildStockSeries({ ...quote, daily: [] }, '1Y', NOW_MS)).toBeNull();
  });
});
