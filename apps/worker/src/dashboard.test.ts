import { DASHBOARD_RANGE_PLAN, DashboardResponse, MarketTickerResponse } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createDashboardService } from './dashboard.ts';
import { createMarketSource } from './market.ts';

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
    const bad = await app1.request('/api/dashboard?range=1Y', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(bad.status).toBe(400);
    expect(read).toHaveBeenCalledTimes(1); // the invalid range never reaches the provider-facing service
  });

  it('answers 404 when the service is not composed', async () => {
    const res = await app().request('/api/dashboard', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(404);
  });
});

describe('real Dashboard composition (no live provider)', () => {
  const market = (fetchImpl: typeof fetch) => createDashboardService({ market: createMarketSource({ fetch: fetchImpl, now: () => NOW_MS }), now: () => new Date(NOW_MS) });

  it('builds the BTC/USD market card plus honest non-ok overview cards', async () => {
    const service = market(async (url) => (String(url).includes('/ticker') ? json({ price: '60123.45', time: '2026-09-30T11:59:59Z' }) : json([bucket(startSec), bucket(startSec + G)])));
    const body = await service.readDashboard('1W');
    const parsed = DashboardResponse.parse(body); // the shipped contract accepts what the worker writes
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'ai-usage', 'health']);
    const card = parsed.cards[0]!;
    expect(card).toMatchObject({ id: 'market', status: 'ok', ticker: { price: 60123.45, providerTime: '2026-09-30T11:59:59.000Z' }, series: { range: '1W' } });
    for (const overview of parsed.cards.slice(1)) {
      expect(overview.status).toBe('not-configured');
      expect(JSON.stringify(overview)).not.toMatch(/[0-9]+ ?(quota|spend|reset|bpm|kcal)/i);
    }
  });

  it('keeps the other cards when the market provider is down', async () => {
    const service = market(async () => new Response('x', { status: 503 }));
    const parsed = DashboardResponse.parse(await service.readDashboard('1M'));
    expect(parsed.cards[0]).toMatchObject({ id: 'market', status: 'unavailable', reason: 'provider-error', observedAt: null });
    expect(parsed.cards.map((c) => c.id)).toEqual(['market', 'ai-usage', 'health']);
  });

  it('serves the ticker-only poll response', async () => {
    const service = market(async () => json({ price: '60000', time: '2026-09-30T12:00:00Z' }));
    expect(MarketTickerResponse.parse(await service.readMarketTicker())).toMatchObject({ status: 'ok', ticker: { price: 60000 } });
    const down = market(async () => new Response('x', { status: 500 }));
    expect(MarketTickerResponse.parse(await down.readMarketTicker())).toMatchObject({ status: 'unavailable', reason: 'provider-error' });
  });
});
