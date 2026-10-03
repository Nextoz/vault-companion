import { DASHBOARD_RANGE_PLAN, DashboardResponse, MarketTickerResponse, WeatherResponse, type DashboardCard } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createDashboardService } from './dashboard.ts';
import { createMarketSource } from './market.ts';
import { WATCHLIST, createWatchlistSource, type WatchItem } from './watchlist.ts';

const ORIGIN = 'https://vc.example.com';
const ACCOUNT = 'a'.repeat(64);
const NOW_MS = Date.parse('2026-09-30T12:00:00Z');
const G = DASHBOARD_RANGE_PLAN['1W'].granularitySeconds;
const endSec = Math.floor(NOW_MS / 1000 / G) * G;
const startSec = endSec - DASHBOARD_RANGE_PLAN['1W'].spanSeconds;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const bucket = (time: number) => [time, '60000', '60200', '60100', '60150', '12'];

const services = (over: Partial<Services> = {}): Services => ({
  async readTasks() { return { code: 'upstream-unavailable', message: 'x', retryable: true }; },
  async execute() { return { code: 'invalid', message: 'x', retryable: false }; },
  ...over,
});

const app = (over: Partial<Services> = {}) =>
  createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: ORIGIN,
    services: services(over),
    log: () => {},
  });

describe('Dashboard routes are authenticated (DASH1)', () => {
  it.each(['/api/dashboard', '/api/dashboard?range=1M', '/api/dashboard/ticker'])('%s without a valid token is 401', async (path) => {
    const res = await app().request(path, { headers: { 'Cf-Access-Jwt-Assertion': 'bad' } });
    expect(res.status).toBe(401);
  });

  it('serves the dashboard to a signed-in owner and passes the parsed range only', async () => {
    const read = vi.fn(async () => ({ now: new Date(NOW_MS).toISOString(), cards: [] }));
    const res = await app({ readDashboard: read }).request('/api/dashboard?range=3M', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith('3M');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('defaults to 1W and refuses an unknown range without calling the service', async () => {
    const read = vi.fn(async () => ({ now: new Date(NOW_MS).toISOString(), cards: [] }));
    const app1 = app({ readDashboard: read });
    await app1.request('/api/dashboard', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(read).toHaveBeenLastCalledWith('1W');
    const bad = await app1.request('/api/dashboard?range=2Y', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(bad.status).toBe(400);
    expect(read).toHaveBeenCalledTimes(1); // the invalid range never reaches the provider-facing service
  });

  it('answers 404 when the service is not composed', async () => {
    const res = await app().request('/api/dashboard', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(404);
  });
});

describe('real Dashboard composition (no live provider)', () => {
  const weatherUnavailable = () => ({
    readWeather: async () => WeatherResponse.parse({ status: 'unavailable', now: new Date(NOW_MS).toISOString(), location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' }, reason: 'provider-error', message: 'No weather.' }),
  });
  const cbrRecord = (date: string, nominal: string, value: string) => `<Record Date="${date}" Id="R01215"><Nominal>${nominal}</Nominal><Value>${value}</Value></Record>`;
  const cbrBody = `<ValCurs Date="30.09.2026" name="DKK">${cbrRecord('29.09.2026', '1', '13,4000')}${cbrRecord('30.09.2026', '1', '13,4547')}</ValCurs>`;

  // One stub for every provider the composed service may reach; `over` can force a single symbol to fail on its own.
  const providerStub = (over: (url: string) => Response | undefined = () => undefined): typeof fetch => async (url) => {
    const u = String(url);
    const forced = over(u);
    if (forced) return forced;
    if (u.includes('api.exchange.coinbase.com')) {
      return u.includes('/ticker') ? json({ price: '60000', time: '2026-09-30T12:00:00Z' }) : json([bucket(startSec), bucket(startSec + G)]);
    }
    if (u.includes('api.frankfurter.dev')) {
      return u.includes('/latest')
        ? json({ amount: 1, base: 'SEK', date: '2026-09-30', rates: { DKK: 0.6876 } })
        : json({ amount: 1, base: 'SEK', rates: { '2026-09-29': { DKK: 0.6874 }, '2026-09-30': { DKK: 0.6876 } } });
    }
    if (u.includes('cbr.ru')) return new Response(cbrBody, { status: 200 });
    return new Response('x', { status: 404 });
  };

  const service = (fetchImpl: typeof fetch, items?: readonly WatchItem[]) =>
    createDashboardService({
      market: createMarketSource({ fetch: fetchImpl, now: () => NOW_MS }),
      watchlist: createWatchlistSource({ fetch: fetchImpl, now: () => NOW_MS, ...(items ? { items } : {}) }),
      weather: weatherUnavailable(),
      now: () => new Date(NOW_MS),
    });

  it('builds the legacy BTC/USD market card, one card per watched item, and honest non-ok overview cards', async () => {
    const parsed = DashboardResponse.parse(await service(providerStub()).readDashboard('1W')); // the shipped contract accepts what the worker writes
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'watchlist', 'watchlist', 'watchlist', 'watchlist', 'weather', 'ai-usage', 'health']);
    // The old market card is unchanged, so the existing web Dashboard keeps working.
    expect(parsed.cards[0]).toMatchObject({ id: 'market', status: 'ok', title: 'BTC / USD', ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60000 }, series: { range: '1W' } });
    const watches = parsed.cards.slice(1, 5) as Extract<DashboardCard, { id: 'watchlist' }>[];
    expect(watches.map((c) => c.item)).toEqual([
      { symbol: 'BTC-USD', type: 'crypto' }, { symbol: 'ETH-USD', type: 'crypto' }, { symbol: 'RUB/DKK', type: 'fx' }, { symbol: 'SEK/DKK', type: 'fx' },
    ]);
    expect(watches[3]).toMatchObject({ status: 'ok', title: 'SEK / DKK', provenance: 'Frankfurter (ECB reference rates)', ticker: { base: 'SEK', quote: 'DKK', price: 0.6876 } });
    expect(parsed.cards[5]).toMatchObject({ id: 'weather', status: 'unavailable', reason: 'provider-error' });
    for (const overview of parsed.cards.slice(6)) {
      expect(overview.status).toBe('not-configured');
      expect(JSON.stringify(overview)).not.toMatch(/[0-9]+ ?(quota|spend|reset|bpm|kcal)/i);
    }
  });

  it('one failing item is an unavailable card and never breaks the others', async () => {
    const parsed = DashboardResponse.parse(await service(providerStub((u) => (u.includes('ETH-USD') ? new Response('x', { status: 503 }) : undefined))).readDashboard('1W'));
    const watches = parsed.cards.filter((c): c is Extract<DashboardCard, { id: 'watchlist' }> => c.id === 'watchlist');
    expect(watches[1]).toMatchObject({ status: 'unavailable', item: { symbol: 'ETH-USD' }, reason: 'provider-error', observedAt: null, fetchedAt: null });
    expect(watches[0]).toMatchObject({ status: 'ok', item: { symbol: 'BTC-USD' } });
    expect(parsed.cards[0]).toMatchObject({ id: 'market', status: 'ok' });
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'watchlist', 'watchlist', 'watchlist', 'watchlist', 'weather', 'ai-usage', 'health']);
  });

  it('adding one config line yields one more card, and the contract accepts it', async () => {
    const items = [...WATCHLIST, { symbol: 'ADA-USD', type: 'crypto' as const, name: 'ADA / USD', base: 'ADA', quote: 'USD' }];
    const parsed = DashboardResponse.parse(await service(providerStub(), items).readDashboard('1W'));
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'watchlist', 'watchlist', 'watchlist', 'watchlist', 'watchlist', 'weather', 'ai-usage', 'health']);
    expect(parsed.cards[5]).toMatchObject({ id: 'watchlist', status: 'ok', item: { symbol: 'ADA-USD' } });
  });

  it('keeps the other cards when the market provider is down', async () => {
    const parsed = DashboardResponse.parse(await service(async () => new Response('x', { status: 503 })).readDashboard('1M'));
    expect(parsed.cards[0]).toMatchObject({ id: 'market', status: 'unavailable', reason: 'provider-error', observedAt: null });
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'watchlist', 'watchlist', 'watchlist', 'watchlist', 'weather', 'ai-usage', 'health']);
    expect(parsed.cards[1]).toMatchObject({ id: 'watchlist', status: 'unavailable' });
    expect(parsed.cards[5]).toMatchObject({ id: 'weather', status: 'unavailable' });
  });

  it('serves the ticker-only poll response', async () => {
    const up = service(async () => json({ price: '60000', time: '2026-09-30T12:00:00Z' }));
    expect(MarketTickerResponse.parse(await up.readMarketTicker())).toMatchObject({ status: 'ok', ticker: { price: 60000 } });
    const down = service(async () => new Response('x', { status: 500 }));
    expect(MarketTickerResponse.parse(await down.readMarketTicker())).toMatchObject({ status: 'unavailable', reason: 'provider-error' });
  });
});
