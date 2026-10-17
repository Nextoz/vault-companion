/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { POWER_REASON_NOTES, PowerResponse } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { POWER_CACHE_TTL_MS, createPowerProvider } from './power-provider.ts';

const NOW_MS = Date.parse('2026-10-16T17:15:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const TIME_ZONE = 'Europe/Copenhagen';
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/monitors/${name}`, import.meta.url), 'utf8'));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const PRICES = fixture('day-ahead-prices-dk2.json');
const CO2 = fixture('co2-emis-dk2.json');
const CO2_PROG = fixture('co2-prog-dk2.json');

type Handler = () => Response | Promise<Response>;

/** Fetch stub routed by dataset URL, overridable per test; every URL is recorded and each call overlaps in flight. */
function stubFetch(over: { prices?: Handler; co2?: Handler; co2Prog?: Handler } = {}) {
  const urls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes('DayAheadPrices')) return over.prices ? over.prices() : ok(PRICES);
    if (url.includes('CO2EmisProg')) return over.co2Prog ? over.co2Prog() : ok(CO2_PROG);
    if (url.includes('CO2Emis?')) return over.co2 ? over.co2() : ok(CO2);
    throw new Error(`unexpected provider URL: ${url}`);
  };
  return { fetch: impl, urls };
}

const provider = (fetchImpl: typeof fetch, now: () => number, timeoutMs?: number) =>
  createPowerProvider({ fetch: fetchImpl, now, timeZone: TIME_ZONE, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

describe('power provider (real captures)', () => {
  it('builds the fixed DK2 URLs, projects the capture, and reuses parsed rows inside the TTL', async () => {
    const stub = stubFetch();
    let now = NOW_MS;
    const read = provider(stub.fetch, () => now).read;
    const first = await read();
    expect(first.status).toBe('ok');
    expect(PowerResponse.parse(first)).toEqual(first);
    expect(first).toMatchObject({ status: 'ok', now: NOW_ISO, fetchedAt: NOW_ISO, area: 'DK2' });
    expect(stub.urls).toHaveLength(3);
    const pricesUrl = stub.urls.find((url) => url.includes('DayAheadPrices'))!;
    expect(pricesUrl).toContain('start=2026-10-16T00:00&end=2026-10-18T00:00');
    expect(pricesUrl).toContain('%22DK2%22');
    now += POWER_CACHE_TTL_MS - 60_000; // 14 min later, same Copenhagen day: no refetch, but now moves
    const second = await read();
    expect(second).toMatchObject({ status: 'ok', now: new Date(now).toISOString(), fetchedAt: NOW_ISO });
    expect(stub.urls).toHaveLength(3);
    now += 2 * 60_000; // 16 min after the fetch
    const third = await read();
    expect(third).toMatchObject({ status: 'ok', fetchedAt: new Date(now).toISOString() });
    expect(stub.urls).toHaveLength(6);
  });

  it('shares one in-flight refresh between concurrent reads', async () => {
    const stub = stubFetch();
    const read = provider(stub.fetch, () => NOW_MS).read;
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(stub.urls).toHaveLength(3);
  });

  it('reports provider failures when no cached rows exist to fall back on', async () => {
    const error = stubFetch({ prices: () => new Response('x', { status: 500 }) });
    await expect(provider(error.fetch, () => NOW_MS).read()).resolves.toEqual({
      status: 'unavailable', now: NOW_ISO, reason: 'provider-error', note: POWER_REASON_NOTES['provider-error'],
    });
    const malformed = stubFetch({ prices: () => ok({}) });
    await expect(provider(malformed.fetch, () => NOW_MS).read()).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed' });
    const hang = stubFetch({ prices: () => new Promise<Response>(() => {}) });
    await expect(provider(hang.fetch, () => NOW_MS, 20).read()).resolves.toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  it('serves cached rows with their ORIGINAL fetchedAt when a refresh fails after the TTL', async () => {
    let fail = false;
    const stub = stubFetch({ prices: () => (fail ? new Response('x', { status: 500 }) : ok(PRICES)) });
    let now = NOW_MS;
    const read = provider(stub.fetch, () => now).read;
    await expect(read()).resolves.toMatchObject({ status: 'ok', fetchedAt: NOW_ISO });
    fail = true;
    now += POWER_CACHE_TTL_MS + 60_000; // 16 min: the refresh is attempted and fails
    const stale = await read();
    expect(stale).toMatchObject({ status: 'ok', fetchedAt: NOW_ISO, now: new Date(now).toISOString() });
    expect(stub.urls).toHaveLength(6);
  });

  it('never fails the response when a CO2 input fails: that input is null', async () => {
    const measuredDown = stubFetch({ co2: () => new Response('x', { status: 500 }) });
    const forecast = await provider(measuredDown.fetch, () => NOW_MS).read();
    expect(forecast).toMatchObject({ status: 'ok', co2: { at: '2026-10-16T17:15:00.000Z', gPerKwh: 38, kind: 'forecast' } });
    const bothDown = stubFetch({ co2: () => new Response('x', { status: 500 }), co2Prog: () => new Response('x', { status: 500 }) });
    const withoutCo2 = await provider(bothDown.fetch, () => NOW_MS).read();
    expect(withoutCo2).toMatchObject({ status: 'ok', co2: null });
  });

  it('reports empty when the price capture has no rows for today', async () => {
    const stub = stubFetch({ prices: () => ok(fixture('day-ahead-prices-empty.json')) });
    await expect(provider(stub.fetch, () => NOW_MS).read()).resolves.toEqual({
      status: 'unavailable', now: NOW_ISO, reason: 'empty', note: POWER_REASON_NOTES.empty,
    });
  });
});

const ORIGIN = 'https://vc.example.com';
const SERVICES: Services = {
  readTasks: async () => ({ code: 'upstream-unavailable', message: 'test', retryable: true }),
  execute: async () => ({ code: 'invalid', message: 'test', retryable: false }),
};

describe('power route', () => {
  it('requires auth, always answers 200, and 404s without the service', async () => {
    const readPower = vi.fn(async () => ({ status: 'unavailable' as const, now: new Date(0).toISOString(), reason: 'timeout' as const, note: POWER_REASON_NOTES.timeout }));
    const app = createApp({
      services: { ...SERVICES, readPower },
      appOrigin: ORIGIN,
      log: () => {},
      verify: async (token) => (token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false }),
    });
    expect((await app.request('/api/power')).status).toBe(401);
    expect(readPower).not.toHaveBeenCalled();
    const response = await app.request('/api/power', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(readPower).toHaveBeenCalledTimes(1);
    const bare = createApp({
      services: SERVICES,
      appOrigin: ORIGIN,
      log: () => {},
      verify: async (token) => (token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false }),
    });
    expect((await bare.request('/api/power', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } })).status).toBe(404);
  });
});
