import { DASHBOARD_RANGE_PLAN, MARKET_BASE_URL } from '@vault-companion/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICKER_TTL_MS } from './market.ts';
import {
  FX_SERIES_TTL_MS,
  WATCHLIST,
  createCryptoAdapter,
  createFxAdapter,
  createWatchlistSource,
  cbrTicker,
  decodeCbr,
  dkkPerRub,
  parseCbrRecords,
  parseFrankfurterLatest,
  parseFrankfurterSeries,
  type WatchItem,
} from './watchlist.ts';

const NOW_MS = Date.parse('2026-09-30T12:00:00Z');
const G = DASHBOARD_RANGE_PLAN['1W'].granularitySeconds;
const endSec = Math.floor(NOW_MS / 1000 / G) * G;
const startSec = endSec - DASHBOARD_RANGE_PLAN['1W'].spanSeconds;
const DAY = 86_400;
const fxEnd = Math.floor(NOW_MS / 1000 / DAY) * DAY + DAY;
const fxStart = fxEnd - DASHBOARD_RANGE_PLAN['1W'].spanSeconds;
const yStart = fxEnd - DASHBOARD_RANGE_PLAN['1Y'].spanSeconds;
const yEnd = fxEnd - DAY;

const BTC: WatchItem = { symbol: 'BTC-USD', type: 'crypto', name: 'BTC / USD', base: 'BTC', quote: 'USD' };
const ETH: WatchItem = { symbol: 'ETH-USD', type: 'crypto', name: 'ETH / USD', base: 'ETH', quote: 'USD' };
const SEK: WatchItem = { symbol: 'SEK/DKK', type: 'fx', name: 'SEK / DKK', base: 'SEK', quote: 'DKK' };
const RUB: WatchItem = { symbol: 'RUB/DKK', type: 'fx', name: 'RUB / DKK', base: 'RUB', quote: 'DKK' };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const bucket = (time: number) => [time, '60000', '60200', '60100', '60150', '12'];
const cbrRecord = (date: string, nominal: string, value: string) => `<Record Date="${date}" Id="R01215"><Nominal>${nominal}</Nominal><Value>${value}</Value></Record>`;
const cbrBody = (records: string) => `<ValCurs Date="30.09.2026" name="DKK">${records}</ValCurs>`;

afterEach(() => vi.useRealTimers());

describe('crypto adapter (Coinbase, per symbol)', () => {
  it('reads the configured product, not the legacy BTC-USD one', async () => {
    const urls: string[] = [];
    const adapter = createCryptoAdapter({ now: () => NOW_MS, fetch: async (url) => { urls.push(String(url)); return json({ price: '2500', time: '2026-09-30T12:00:00Z' }); } });
    await expect(adapter.ticker(ETH)).resolves.toMatchObject({ status: 'ok', ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 2500 } });
    expect(urls[0]).toBe(`${MARKET_BASE_URL}/products/ETH-USD/ticker`);
  });

  it('parses a series and refuses a malformed body', async () => {
    const ok = createCryptoAdapter({ now: () => NOW_MS, fetch: async () => json([bucket(startSec), bucket(startSec + G)]) });
    await expect(ok.series(BTC, '1W')).resolves.toMatchObject({ status: 'ok', series: { range: '1W', granularitySeconds: G } });
    const bad = createCryptoAdapter({ now: () => NOW_MS, fetch: async () => json({ candles: 'nope' }) });
    await expect(bad.series(BTC, '1W')).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
    await expect(bad.ticker(BTC)).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
  });

  it('reports a provider error and a timeout instead of a value', async () => {
    const down = createCryptoAdapter({ now: () => NOW_MS, fetch: async () => new Response('x', { status: 500 }) });
    await expect(down.ticker(BTC)).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
    vi.useFakeTimers();
    const stalled = createCryptoAdapter({ now: () => NOW_MS, fetch: () => new Promise<Response>(() => {}), timeoutMs: 1_000 });
    const pending = stalled.ticker(BTC);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});

describe('fx adapter (Frankfurter)', () => {
  it('parses the latest rate and the time series, leaving weekend gaps as gaps', async () => {
    const adapter = createFxAdapter({ now: () => NOW_MS, fetch: async (url) => String(url).includes('/latest')
      ? json({ amount: 1, base: 'SEK', date: '2026-09-30', rates: { DKK: 0.6876 } })
      : json({ amount: 1, base: 'SEK', rates: { '2026-09-29': { DKK: 0.6874 }, '2026-09-30': { DKK: 0.6876 } } }) });
    await expect(adapter.ticker(SEK)).resolves.toEqual({ status: 'ok', ticker: { base: 'SEK', quote: 'DKK', provider: 'frankfurter', price: 0.6876, providerTime: '2026-09-30T00:00:00Z' }, fetchedAt: NOW_MS });
    const series = await adapter.series(SEK, '1W');
    expect(series).toMatchObject({ status: 'ok', series: { range: '1W', granularitySeconds: DAY, missingIntervals: 5 } });
    if (series.status === 'ok') expect(series.series.points.at(-1)).toMatchObject({ close: 0.6876 });
  });

  it('refuses a malformed rate, an unknown pair and a stall', async () => {
    const bad = createFxAdapter({ now: () => NOW_MS, fetch: async () => json({ amount: 1, base: 'SEK', rates: {} }) });
    await expect(bad.ticker(SEK)).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
    await expect(bad.series(SEK, '1W')).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
    const weird: WatchItem = { symbol: 'SEK/US', type: 'fx', name: 'SEK / US' };
    await expect(bad.ticker(weird)).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
    vi.useFakeTimers();
    const stalled = createFxAdapter({ now: () => NOW_MS, fetch: () => new Promise<Response>(() => {}), timeoutMs: 1_000 });
    const pending = stalled.ticker(SEK);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('parses the contract directly: unknown dates are skipped', () => {
    expect(parseFrankfurterLatest({ date: '2026-09-30', rates: { DKK: '0.68' } }, 'SEK', 'DKK')).toMatchObject({ price: 0.68 });
    expect(parseFrankfurterLatest({ rates: { DKK: 0.68 } }, 'SEK', 'DKK')).toBeNull();
    const series = parseFrankfurterSeries({ rates: { nope: { DKK: 1 }, '2026-09-30': { DKK: 0.6876 } } }, 'DKK', '1W', fxStart, fxEnd);
    expect(series?.points).toHaveLength(1);
  });
});

describe('fx adapter (Bank of Russia XML)', () => {
  // Production guard: CBR is windows-1251. Decoding it as UTF-8 is a broken guard, not an acceptable fallback.
  it('decodes windows-1251, not UTF-8', () => {
    const bytes = new Uint8Array([0xc4, 0xee, 0xeb]); // "Дол" in windows-1251
    expect(decodeCbr(bytes)).toBe('Дол');
    expect(new TextDecoder().decode(bytes)).not.toBe('Дол');
  });

  it('parses comma decimals and sorts records; a foreign document is refused', () => {
    const xml = cbrBody(`${cbrRecord('30.09.2026', '1', '13,4547')}${cbrRecord('29.09.2026', '1', '13,4000')}`);
    expect(parseCbrRecords(xml)).toEqual([
      { date: '2026-09-29', nominal: 1, value: 13.4 },
      { date: '2026-09-30', nominal: 1, value: 13.4547 },
    ]);
    expect(parseCbrRecords('<html>not cbr</html>')).toBeNull();
    expect(parseCbrRecords(cbrBody(''))).toEqual([]);
  });

  // Production guard: CBR states RUB per Nominal DKK; the card must invert to DKK per 1 RUB.
  it('inverts to DKK per 1 RUB instead of passing the provider number through', () => {
    const records = parseCbrRecords(cbrBody(cbrRecord('30.09.2026', '1', '13,4547')))!;
    expect(dkkPerRub(records[0]!)).toBeCloseTo(1 / 13.4547, 10);
    const ticker = cbrTicker(records, 'RUB', 'DKK')!;
    expect(ticker.price).toBeCloseTo(1 / 13.4547, 8);
    expect(ticker.price).not.toBeCloseTo(13.4547, 2);
  });

  it('serves a latest ticker and a daily series from the same XML', async () => {
    const body = cbrBody(`${cbrRecord('29.09.2026', '1', '13,4000')}${cbrRecord('30.09.2026', '1', '13,4547')}`);
    const adapter = createFxAdapter({ now: () => NOW_MS, fetch: async (url) => (String(url).includes('cbr.ru') ? new Response(body, { status: 200 }) : new Response('x', { status: 404 })) });
    const ticker = await adapter.ticker(RUB);
    expect(ticker).toMatchObject({ status: 'ok', ticker: { base: 'RUB', quote: 'DKK', provider: 'cbr', providerTime: '2026-09-30T00:00:00Z' } });
    if (ticker.status === 'ok') expect(ticker.ticker.price).toBeCloseTo(1 / 13.4547, 10);
    const series = await adapter.series(RUB, '1W');
    expect(series).toMatchObject({ status: 'ok', series: { range: '1W', granularitySeconds: DAY } });
    if (series.status === 'ok') expect(series.series.points.at(-1)?.close).toBeCloseTo(1 / 13.4547, 10);
    const empty = createFxAdapter({ now: () => NOW_MS, fetch: async () => new Response(cbrBody(''), { status: 200 }) });
    await expect(empty.ticker(RUB)).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
  });
});

describe('watchlist source', () => {
  it('defaults to the shipped config and honors a custom one', () => {
    const deps = { now: () => NOW_MS, fetch: async () => new Response('x', { status: 500 }) };
    expect(createWatchlistSource(deps).items).toEqual(WATCHLIST);
    const extra = [...WATCHLIST, { symbol: 'ADA-USD', type: 'crypto' as const, name: 'ADA / USD' }];
    expect(createWatchlistSource({ ...deps, items: extra }).items).toHaveLength(WATCHLIST.length + 1);
  });

  it('caches inside the TTL and never repaints a failed refresh as a current value', async () => {
    let nowMs = NOW_MS;
    let fail = false;
    let price = '100';
    const source = createWatchlistSource({
      now: () => nowMs,
      fetch: async (url) => (fail ? new Response('x', { status: 503 }) : String(url).includes('/ticker') ? json({ price, time: '2026-09-30T12:00:00Z' }) : json([bucket(startSec)])),
    });
    const first = await source.ticker(BTC);
    expect(first).toMatchObject({ status: 'ok', ticker: { price: 100 }, fetchedAt: NOW_MS });
    fail = true;
    nowMs += TICKER_TTL_MS / 2;
    expect(await source.ticker(BTC)).toEqual(first); // inside the TTL: served from cache, no failed refetch
    nowMs += TICKER_TTL_MS; // past the TTL, and the provider now fails
    const stale = await source.ticker(BTC);
    expect(stale).toEqual(first); // same value AND the ORIGINAL fetchedAt: never repainted as current
    expect(stale).toMatchObject({ fetchedAt: NOW_MS });
    // The cache must still expire: a later success repaints with its own fetchedAt.
    fail = false;
    price = '200';
    nowMs += TICKER_TTL_MS + 1;
    await expect(source.ticker(BTC)).resolves.toMatchObject({ status: 'ok', ticker: { price: 200 }, fetchedAt: nowMs });
  });

  it('keeps a never-fetched failing item unavailable, with its reason', async () => {
    const source = createWatchlistSource({ now: () => NOW_MS, fetch: async () => new Response('x', { status: 503 }) });
    await expect(source.ticker(WATCHLIST[1]!)).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
    await expect(source.series(WATCHLIST[1]!, '1M')).resolves.toEqual({ status: 'unavailable', reason: 'provider-error' });
  });
});

describe('1Y range (WL3)', () => {
  // Production guard: 1Y crypto must be two bounded daily requests merged, not one over-cap request or a truncated year.
  it('fetches a 1Y crypto series as two bounded daily requests and merges the year', async () => {
    const urls: string[] = [];
    const adapter = createCryptoAdapter({ now: () => NOW_MS, fetch: async (url) => {
      urls.push(String(url));
      const query = new URL(String(url)).searchParams;
      const from = Number(query.get('start'));
      const to = Number(query.get('end'));
      return json(Array.from({ length: (to - from) / DAY }, (_, i) => bucket(from + i * DAY)));
    } });
    const out = await adapter.series(BTC, '1Y');
    expect(out).toMatchObject({ status: 'ok', series: { range: '1Y', granularitySeconds: DAY, missingIntervals: 0 } });
    if (out.status === 'ok') expect(out.series.points).toHaveLength(DASHBOARD_RANGE_PLAN['1Y'].spanSeconds / DAY);
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toContain('granularity=86400');
  });

  it('asks Frankfurter for a ~365-day 1Y window, not the 3M one', async () => {
    const urls: string[] = [];
    const adapter = createFxAdapter({ now: () => NOW_MS, fetch: async (url) => {
      urls.push(String(url));
      return json({ amount: 1, base: 'SEK', rates: { '2025-10-01': { DKK: 0.69 }, '2026-09-30': { DKK: 0.6876 } } });
    } });
    const out = await adapter.series(SEK, '1Y');
    expect(out).toMatchObject({ status: 'ok', series: { range: '1Y', granularitySeconds: DAY } });
    const url = urls[0]!;
    expect(url).toContain('api.frankfurter.dev');
    const match = /(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(url)!;
    expect(match[1]).toBe(new Date(yStart * 1000).toISOString().slice(0, 10));
    expect(match[2]).toBe(new Date(yEnd * 1000).toISOString().slice(0, 10));
    expect((Date.parse(match[2]!) - Date.parse(match[1]!)) / 86_400_000).toBe(364); // a year, inclusive of both ends
  });

  it('asks Bank of Russia for the same ~365-day window on 1Y', async () => {
    let seenUrl = '';
    const adapter = createFxAdapter({ now: () => NOW_MS, fetch: async (url) => {
      seenUrl = String(url);
      return new Response(cbrBody(`${cbrRecord('29.09.2026', '1', '13,4000')}${cbrRecord('30.09.2026', '1', '13,4547')}`), { status: 200 });
    } });
    await expect(adapter.series(RUB, '1Y')).resolves.toMatchObject({ status: 'ok', series: { range: '1Y' } });
    const match = /date_req1=(\d{2})\/(\d{2})\/(\d{4})&date_req2=(\d{2})\/(\d{2})\/(\d{4})/.exec(seenUrl)!;
    const from = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    const to = Date.UTC(Number(match[6]), Number(match[5]) - 1, Number(match[4]));
    expect((to - from) / 86_400_000).toBe(364);
  });

  it('adds 1Y to the fx series TTL, cached well past 3M', () => {
    expect(FX_SERIES_TTL_MS['1Y']).toBe(12 * 60 * 60_000);
    expect(FX_SERIES_TTL_MS['1Y']).toBeGreaterThan(FX_SERIES_TTL_MS['3M']);
  });

  it('serves a 1Y series from cache inside its TTL and keeps the original fetchedAt on a failed refresh', async () => {
    let nowMs = NOW_MS;
    let fail = false;
    let fetches = 0;
    const source = createWatchlistSource({ now: () => nowMs, fetch: async (url) => {
      fetches += 1;
      if (fail) return new Response('x', { status: 503 });
      const query = new URL(String(url)).searchParams;
      const from = Number(query.get('start'));
      const to = Number(query.get('end'));
      return json(Array.from({ length: (to - from) / DAY }, (_, i) => bucket(from + i * DAY)));
    } });
    const first = await source.series(BTC, '1Y');
    expect(first).toMatchObject({ status: 'ok', fetchedAt: NOW_MS, series: { range: '1Y' } });
    const afterFirst = fetches;
    fail = true;
    nowMs += 1_000;
    expect(await source.series(BTC, '1Y')).toEqual(first); // inside the 1Y TTL: no failed refetch
    expect(fetches).toBe(afterFirst);
    nowMs += 12 * 60 * 60_000; // past the 1Y TTL, and the provider now fails
    const stale = await source.series(BTC, '1Y');
    expect(stale).toEqual(first); // same series AND the ORIGINAL fetchedAt, never repainted as current
    if (stale.status === 'ok') expect(stale.fetchedAt).toBe(NOW_MS);
  });
});
