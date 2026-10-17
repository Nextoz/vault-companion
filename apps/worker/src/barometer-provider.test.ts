/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { BAROMETER_REASON_NOTES, BarometerResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { BAROMETER_CACHE_TTL_MS, createBarometerProvider } from './barometer-provider.ts';

const NOW_MS = Date.parse('2026-10-17T06:45:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/monitors/${name}`, import.meta.url), 'utf8'));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const error = () => new Response('x', { status: 500 });
const hang = () => new Promise<Response>(() => {});
const STATION: Record<string, unknown> = { '06180': fixture('dmi-pressure-06180.json'), '06181': fixture('dmi-pressure-06181.json') };
const MODEL = fixture('open-meteo-pressure-dmi.json');

type Handler = () => Response | Promise<Response>;

/** Fetch stub routed by the fixed station and model URLs, overridable per test; every URL is recorded and each call overlaps in flight. */
function stubFetch(over: { '06180'?: Handler; '06181'?: Handler; model?: Handler } = {}) {
  const urls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes('stationId=06180')) return over['06180'] ? over['06180']() : ok(STATION['06180']);
    if (url.includes('stationId=06181')) return over['06181'] ? over['06181']() : ok(STATION['06181']);
    if (url.includes('open-meteo')) return over.model ? over.model() : ok(MODEL);
    throw new Error(`unexpected provider URL: ${url}`);
  };
  return { fetch: impl, urls };
}

const provider = (fetchImpl: typeof fetch, now: () => number, timeoutMs?: number) =>
  createBarometerProvider({ fetch: fetchImpl, now, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

describe('barometer provider (real captures)', () => {
  it('builds the fixed station URLs, never the model, and projects the capture', async () => {
    const stub = stubFetch();
    const first = await provider(stub.fetch, () => NOW_MS).read();
    expect(BarometerResponse.parse(first)).toEqual(first);
    expect(first).toMatchObject({
      status: 'ok', now: NOW_ISO, fetchedAt: NOW_ISO, source: 'dmi', place: 'Trianglen', hPa: 1020.2,
      observedAt: '2026-10-17T06:40:00.000Z', hPaThreeHoursAgo: 1018.9, changeHpa: 1.3, trend: 'rising', zone: 'Fair',
    });
    expect(stub.urls).toHaveLength(2);
    for (const id of ['06180', '06181']) {
      const url = stub.urls.find((u) => u.includes(`stationId=${id}`))!;
      expect(url).toContain('pressure_at_sea');
      expect(url).toContain('period=latest-day');
    }
    expect(stub.urls.some((u) => u.includes('open-meteo'))).toBe(false);
  });

  it('reuses the parsed stations inside the TTL but recomputes the projection, refreshing after it', async () => {
    const stub = stubFetch();
    let now = NOW_MS;
    const read = provider(stub.fetch, () => now).read;
    await expect(read()).resolves.toMatchObject({ status: 'ok', fetchedAt: NOW_ISO });
    now += 9 * 60_000; // 9 min later: no refetch, but the projection's `now` moves
    await expect(read()).resolves.toMatchObject({ status: 'ok', now: new Date(now).toISOString(), fetchedAt: NOW_ISO });
    expect(stub.urls).toHaveLength(2);
    now += 2 * 60_000; // 11 min after the fetch: the stations are fetched again
    await expect(read()).resolves.toMatchObject({ status: 'ok', fetchedAt: new Date(now).toISOString() });
    expect(stub.urls).toHaveLength(4);
  });

  it('shares one in-flight refresh between concurrent reads', async () => {
    const stub = stubFetch();
    const read = provider(stub.fetch, () => NOW_MS).read;
    const [a, b] = await Promise.all([read(), read()]);
    expect(a).toEqual(b);
    expect(stub.urls).toHaveLength(2);
  });

  it('still measures from the other station when one fails', async () => {
    const stub = stubFetch({ '06180': error }); // Kastrup down; Jægersborg alone: 1020.27 -> 1020.3
    await expect(provider(stub.fetch, () => NOW_MS).read()).resolves.toMatchObject({
      status: 'ok', source: 'dmi', hPa: 1020.3, fetchedAt: NOW_ISO,
    });
  });

  it('stands the model in, never labelled dmi, when both stations are stale', async () => {
    const modelNowFresh = () => {
      const body = fixture('open-meteo-pressure-dmi.json') as { current: { time: string } };
      body.current.time = '2026-10-17T07:50'; // the capture's 06:45 current time is stale at 07:55
      return ok(body);
    };
    const stub = stubFetch({ model: modelNowFresh });
    const later = Date.parse('2026-10-17T07:55:00Z');
    await expect(provider(stub.fetch, () => later).read()).resolves.toMatchObject({
      status: 'ok', source: 'model', hPa: 1019.9, fetchedAt: new Date(later).toISOString(),
    });
    expect(stub.urls).toHaveLength(3); // both stale stations tried, then the model
  });

  it('stands the model in when both stations fail', async () => {
    const stub = stubFetch({ '06180': error, '06181': error });
    await expect(provider(stub.fetch, () => NOW_MS).read()).resolves.toMatchObject({
      status: 'ok', source: 'model', hPa: 1019.9, fetchedAt: NOW_ISO,
    });
  });

  it('reports provider errors, timeouts, and malformed bodies when nothing is cached', async () => {
    const down = stubFetch({ '06180': error, '06181': error, model: error });
    await expect(provider(down.fetch, () => NOW_MS).read()).resolves.toEqual({
      status: 'unavailable', now: NOW_ISO, reason: 'provider-error', note: BAROMETER_REASON_NOTES['provider-error'],
    });
    const stuck = stubFetch({ '06180': hang, '06181': hang, model: hang });
    await expect(provider(stuck.fetch, () => NOW_MS, 20).read()).resolves.toMatchObject({ status: 'unavailable', reason: 'timeout' });
    const junk = stubFetch({ '06180': () => ok({}), '06181': () => ok({}), model: () => ok({}) });
    await expect(provider(junk.fetch, () => NOW_MS).read()).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed' });
  });

  it('serves the cached stations with their ORIGINAL fetchedAt when a refresh fails after the TTL', async () => {
    let fail = false;
    const flip = (body: unknown): Handler => () => (fail ? error() : ok(body));
    const stub = stubFetch({ '06180': flip(STATION['06180']), '06181': flip(STATION['06181']), model: flip(MODEL) });
    let now = NOW_MS;
    const read = provider(stub.fetch, () => now).read;
    await expect(read()).resolves.toMatchObject({ status: 'ok', fetchedAt: NOW_ISO });
    fail = true;
    now += BAROMETER_CACHE_TTL_MS + 60_000; // 11 min: the refresh is attempted and fails everywhere
    const stale = await read();
    expect(stale).toMatchObject({ status: 'ok', fetchedAt: NOW_ISO, now: new Date(now).toISOString() }); // not repainted
    expect(stub.urls).toHaveLength(5); // the first pair plus the failed refresh's two stations and the model
  });
});
