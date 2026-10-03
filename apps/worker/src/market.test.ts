import { DASHBOARD_RANGE_PLAN, MARKET_BASE_URL, MAX_MARKET_POINTS } from '@vault-companion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COINBASE_MAX_CANDLES, candleWindows, candlesUrl, createMarketSource, parseCandles, parseTicker, tickerUrl, TICKER_TTL_MS, MAX_BODY_BYTES } from './market.ts';

const NOW_MS = Date.parse('2026-09-30T12:00:00Z');
const G = DASHBOARD_RANGE_PLAN['1W'].granularitySeconds;
const SPAN = DASHBOARD_RANGE_PLAN['1W'].spanSeconds;
const endSec = Math.floor(NOW_MS / 1000 / G) * G;
const startSec = endSec - SPAN;
const Y_G = 86_400;
const yEnd = Math.floor(NOW_MS / 1000 / Y_G) * Y_G;
const yStart = yEnd - DASHBOARD_RANGE_PLAN['1Y'].spanSeconds;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const bucket = (time: number, overrides: Record<number, string> = {}): unknown[] => {
  const row: unknown[] = [time, '60000', '60200', '60100', '60150', '12'];
  for (const [i, v] of Object.entries(overrides)) row[Number(i)] = v;
  return row;
};

afterEach(() => vi.useRealTimers());

describe('allowlisted provider URLs (DASH1)', () => {
  it('only ever builds the fixed host/product with an enum granularity', () => {
    expect(tickerUrl()).toBe(`${MARKET_BASE_URL}/products/BTC-USD/ticker`);
    for (const range of ['1W', '1M', '3M', '1Y'] as const) {
      const url = candlesUrl(range, 1, 2);
      expect(url.startsWith(`${MARKET_BASE_URL}/products/BTC-USD/candles?`)).toBe(true);
      expect(url).toContain(`granularity=${DASHBOARD_RANGE_PLAN[range].granularitySeconds}`);
    }
  });
});

describe('provider body validation', () => {
  it('parses a ticker and refuses a non-numeric price', () => {
    expect(parseTicker({ price: '60123.45', time: '2026-09-30T12:00:00.123Z' })).toMatchObject({ price: 60123.45, providerTime: '2026-09-30T12:00:00.123Z' });
    expect(parseTicker({ price: 'not a number', time: '2026-09-30T12:00:00Z' })).toBeNull();
    expect(parseTicker({ price: '-1', time: '2026-09-30T12:00:00Z' })).toBeNull();
  });

  // Production guard-negative: malformed/out-of-window/incoherent buckets must be dropped, never plotted.
  it('drops bad rows, prestart candles and incoherent OHLC, sorts, and counts gaps', () => {
    const rows = [
      bucket(startSec + 2 * G), // present
      bucket(startSec), // present
      bucket(startSec - G), // prestart: dropped
      bucket(endSec + G), // after the window: dropped
      bucket(startSec + G, { 3: 'x' }), // open not a number: dropped
      [startSec + 3 * G, '10', '5', '6', '7'], // high < low: dropped
      'nonsense', // not a row: dropped
    ];
    const series = parseCandles(rows, '1W', startSec, endSec)!;
    expect(series.points.map((p) => p.time)).toEqual([new Date(startSec * 1000).toISOString(), new Date((startSec + 2 * G) * 1000).toISOString()]);
    expect(series.missingIntervals).toBe(SPAN / G - 2);
  });

  it('returns null when the provider sends the wrong shape', () => {
    expect(parseCandles({}, '1W', startSec, endSec)).toBeNull();
    expect(parseCandles([], '1W', startSec, endSec)!.points).toEqual([]);
  });

  it('caps the series at MAX_MARKET_POINTS even if a provider over-answers', () => {
    const bigStart = yEnd - (MAX_MARKET_POINTS + 50) * Y_G;
    const rows = Array.from({ length: MAX_MARKET_POINTS + 50 }, (_, i) => bucket(bigStart + i * Y_G));
    const series = parseCandles(rows, '1Y', bigStart, yEnd)!;
    expect(series.points.length).toBe(MAX_MARKET_POINTS);
  });
});

describe('windowing long spans (WL3)', () => {
  it('splits a year of daily candles into requests inside the provider cap, ending exactly at the window end', () => {
    const windows = candleWindows('1Y', yStart, yEnd);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ startSec: yStart, endSec: yStart + COINBASE_MAX_CANDLES * Y_G });
    expect(windows[windows.length - 1]!.endSec).toBe(yEnd);
    for (const window of windows) {
      expect((window.endSec - window.startSec) / Y_G).toBeLessThanOrEqual(COINBASE_MAX_CANDLES);
    }
  });

  it('adds no window for the shorter ranges', () => {
    for (const range of ['1W', '1M', '3M'] as const) {
      const end = Math.floor(NOW_MS / 1000 / DASHBOARD_RANGE_PLAN[range].granularitySeconds) * DASHBOARD_RANGE_PLAN[range].granularitySeconds;
      expect(candleWindows(range, end - DASHBOARD_RANGE_PLAN[range].spanSeconds, end)).toHaveLength(1);
    }
  });

  // Production guard: 1Y must merge two bounded requests into a real ~365-day series, not truncate to the first window.
  it('fetches 1Y as two provider requests and concatenates the whole year', async () => {
    const urls: string[] = [];
    const source = createMarketSource({ now: () => NOW_MS, fetch: async (url) => {
      urls.push(String(url));
      const query = new URL(String(url)).searchParams;
      const from = Number(query.get('start'));
      const to = Number(query.get('end'));
      return json(Array.from({ length: (to - from) / Y_G }, (_, i) => bucket(from + i * Y_G)));
    } });
    const out = await source.series('1Y');
    if (out.status !== 'ok') throw new Error('expected an ok 1Y series');
    expect(urls).toHaveLength(2);
    expect(out.series).toMatchObject({ range: '1Y', granularitySeconds: Y_G, missingIntervals: 0 });
    expect(out.series.points).toHaveLength(365);
    for (const url of urls) {
      const query = new URL(url).searchParams;
      expect((Number(query.get('end')) - Number(query.get('start'))) / Y_G).toBeLessThanOrEqual(COINBASE_MAX_CANDLES);
    }
  });

  // Production guard: a failed later window fails the read; a partial year is never passed off as complete.
  it('refuses the 1Y series when any window fails', async () => {
    let calls = 0;
    const source = createMarketSource({ now: () => NOW_MS, fetch: async () => {
      calls += 1;
      return calls === 1 ? json([bucket(yStart)]) : new Response('x', { status: 503 });
    } });
    await expect(source.series('1Y')).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
  });
});

describe('bounded failures', () => {
  it('cancels a missing-length oversized stream before consuming its tail', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls <= 2) controller.enqueue(new Uint8Array(MAX_BODY_BYTES / 2 + 1));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const source = createMarketSource({ fetch: async () => new Response(body), now: () => NOW_MS });
    await expect(source.ticker()).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBe(2);
  });

  it('refuses UTF8 byte overflow even when JSON character count fits', async () => {
    const payload = JSON.stringify({ price: '60000', time: '2026-09-30T12:00:00Z', extra: '�'.repeat(MAX_BODY_BYTES / 2) });
    expect(payload.length).toBeLessThan(MAX_BODY_BYTES);
    expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(MAX_BODY_BYTES);
    const source = createMarketSource({ fetch: async () => new Response(payload), now: () => NOW_MS });
    await expect(source.ticker()).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
  });

  it('uses the remaining total timeout for a stalled body and cancels it even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel });
    const source = createMarketSource({ fetch: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return new Response(body); }, now: () => NOW_MS, timeoutMs: 1000 });
    const pending = source.ticker();
    await vi.advanceTimersByTimeAsync(999);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout when the provider never answers, without waiting forever', async () => {
    vi.useFakeTimers();
    const source = createMarketSource({ fetch: () => new Promise<Response>(() => {}), now: () => NOW_MS, timeoutMs: 1_000 });
    const pending = source.ticker();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('reports a provider error on a non-2xx and malformed on unreadable JSON', async () => {
    const bad = createMarketSource({ fetch: async () => new Response('nope', { status: 500 }), now: () => NOW_MS });
    await expect(bad.ticker()).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
    const junk = createMarketSource({ fetch: async () => new Response('<html>', { status: 200 }), now: () => NOW_MS });
    await expect(junk.ticker()).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
  });

  it('sends a User-Agent on every provider call (Coinbase refuses candles without one, B9)', async () => {
    const agents: (string | null)[] = [];
    const call = createMarketSource({ fetch: async (url, init) => {
      agents.push(new Headers(init?.headers).get('user-agent'));
      return String(url).includes('/ticker') ? json({ price: '60000', time: '2026-09-30T12:00:00Z' }) : json([bucket(endSec - G)]);
    }, now: () => NOW_MS });
    await call.ticker();
    await call.series('1W');
    expect(agents).toEqual(['vault-companion', 'vault-companion']);
  });

  it('keeps a partial history absent rather than inventing one', async () => {
    const call = createMarketSource({ fetch: async (url) => (String(url).includes('/ticker') ? json({ price: '60000', time: '2026-09-30T12:00:00Z' }) : new Response('x', { status: 503 })), now: () => NOW_MS });
    await expect(call.ticker()).resolves.toMatchObject({ status: 'ok' });
    await expect(call.series('1W')).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
  });
});

describe('cache', () => {
  it('serves the ticker from cache inside 60 s and the series well past a minute', async () => {
    let nowMs = NOW_MS;
    let tickerCalls = 0;
    let seriesCalls = 0;
    const source = createMarketSource({
      now: () => nowMs,
      fetch: async (url) => {
        if (String(url).includes('/ticker')) {
          tickerCalls++;
          return json({ price: '60000', time: '2026-09-30T12:00:00Z' });
        }
        seriesCalls++;
        return json([bucket(startSec), bucket(startSec + G)]);
      },
    });
    await source.ticker();
    await source.series('1W');
    nowMs += TICKER_TTL_MS / 2;
    await source.ticker();
    expect(tickerCalls).toBe(1);
    await source.series('1W');
    expect(seriesCalls).toBe(1);
    nowMs += TICKER_TTL_MS / 2 + 1;
    await source.ticker();
    expect(tickerCalls).toBe(2);
    await source.series('1W');
    expect(seriesCalls).toBe(1); // history is not polled every 60 seconds
  });

  it('returns last known data with its ORIGINAL fetchedAt when a later refresh fails', async () => {
    let nowMs = NOW_MS;
    let fail = false;
    const source = createMarketSource({
      now: () => nowMs,
      fetch: async () => (fail ? new Response('x', { status: 503 }) : json({ price: '60000', time: '2026-09-30T12:00:00Z' })),
    });
    const first = await source.ticker();
    expect(first.status).toBe('ok');
    fail = true;
    nowMs += TICKER_TTL_MS + 1;
    const stale = await source.ticker();
    expect(stale).toEqual(first); // visible stale: same old value and same old fetchedAt
  });
});
