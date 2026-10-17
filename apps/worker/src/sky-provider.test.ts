/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { KP_SOURCE_URL, SkyResponse, kpAuroraLevel } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { SKY_CACHE_TTL_MS, createSkyProvider, parseKpBody, projectSky } from './sky-provider.ts';

// Real NOAA SWPC capture (16 Oct 2026): 81 three-hour rows, 9 Oct 00:00 to 19 Oct 00:00 UTC.
const KP = JSON.parse(readFileSync(new URL('../test/fixtures/monitors/kp-forecast.json', import.meta.url), 'utf8')) as unknown;
const NOW_MS = Date.parse('2026-10-16T17:15:00Z');
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('parseKpBody', () => {
  it('parses every row of the real capture, in order, with UTC instants', () => {
    const points = parseKpBody(KP)!;
    expect(points).toHaveLength(81);
    expect(points[0]).toEqual({ time: '2026-10-09T00:00:00.000Z', kp: 3.33, kind: 'observed' });
    expect(points.at(-1)).toMatchObject({ time: '2026-10-19T00:00:00.000Z', kind: 'predicted' });
  });

  it('refuses anything unexpected', () => {
    const row = { time_tag: '2026-10-16T00:00:00', kp: 3, observed: 'observed', noaa_scale: null };
    expect(parseKpBody([row])).toHaveLength(1);
    expect(parseKpBody({})).toBeNull();
    expect(parseKpBody([{ ...row, kp: 9.5 }])).toBeNull();
    expect(parseKpBody([{ ...row, time_tag: '2026-10-16T01:00:00' }])).toBeNull();
    expect(parseKpBody([{ ...row, observed: 'guessed' }])).toBeNull();
    expect(parseKpBody([row, { ...row, time_tag: '2026-10-15T21:00:00' }])).toBeNull();
    expect(parseKpBody([{ ...row, time_tag: '2026-10-16T00:00:00Z' }])).toBeNull();
  });
});

describe('projectSky', () => {
  it('keeps 24 hours back, finds the slot containing now and the next-24-hour maximum', () => {
    const result = projectSky(parseKpBody(KP)!, new Date(NOW_MS), new Date(NOW_MS).toISOString());
    expect(SkyResponse.parse(result)).toEqual(result);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.points[0]!.time).toBe('2026-10-15T18:00:00.000Z');
    expect(result.points).toHaveLength(27);
    expect(result.current).toEqual({ time: '2026-10-16T15:00:00.000Z', kp: 3, kind: 'estimated' });
    const window = result.points.filter((p) => Date.parse(p.time) + 3 * 3_600_000 > NOW_MS && Date.parse(p.time) < NOW_MS + 24 * 3_600_000);
    expect(result.next24hMax!.kp).toBe(Math.max(...window.map((p) => p.kp)));
  });

  it('is unavailable (empty) with no rows in range', () => {
    expect(projectSky([], new Date(NOW_MS), 'x')).toMatchObject({ status: 'unavailable', reason: 'empty' });
  });
});

describe('sky provider', () => {
  it('fetches the one fixed URL, caches inside the TTL and refetches after it', async () => {
    const fetchImpl = vi.fn(async (_url: string) => ok(KP));
    let now = NOW_MS;
    const provider = createSkyProvider({ fetch: fetchImpl as unknown as typeof fetch, now: () => now });
    const first = await provider.read();
    expect(first).toMatchObject({ status: 'ok', fetchedAt: new Date(NOW_MS).toISOString() });
    expect(fetchImpl.mock.calls[0]![0]).toBe(KP_SOURCE_URL);
    now += SKY_CACHE_TTL_MS - 1;
    await provider.read();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2;
    await provider.read();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reuses cached rows with their ORIGINAL fetchedAt when the refresh fails (visible stale)', async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => (fail ? new Response('x', { status: 500 }) : ok(KP)));
    let now = NOW_MS;
    const provider = createSkyProvider({ fetch: fetchImpl as unknown as typeof fetch, now: () => now });
    await provider.read();
    fail = true;
    now += SKY_CACHE_TTL_MS + 1;
    expect(await provider.read()).toMatchObject({ status: 'ok', fetchedAt: new Date(NOW_MS).toISOString() });
  });

  it('reports why there is nothing: provider error, malformed body, timeout, empty list', async () => {
    const run = (impl: typeof fetch, timeoutMs?: number) =>
      createSkyProvider({ fetch: impl, now: () => NOW_MS, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }).read();
    expect(await run(async () => new Response('x', { status: 500 }))).toMatchObject({ status: 'unavailable', reason: 'provider-error' });
    expect(await run(async () => ok({ not: 'an array' }))).toMatchObject({ status: 'unavailable', reason: 'malformed' });
    expect(await run(async () => ok([]))).toMatchObject({ status: 'unavailable', reason: 'empty' });
    expect(await run(() => new Promise<Response>(() => {}), 20)).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  it('shares one in-flight refresh between concurrent reads', async () => {
    const fetchImpl = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return ok(KP); });
    const provider = createSkyProvider({ fetch: fetchImpl as unknown as typeof fetch, now: () => NOW_MS });
    await Promise.all([provider.read(), provider.read(), provider.read()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('kpAuroraLevel', () => {
  it('is low below 5, possible from 5, likely from 7 (Copenhagen latitude)', () => {
    expect([kpAuroraLevel(4.67), kpAuroraLevel(5), kpAuroraLevel(6.67), kpAuroraLevel(7)]).toEqual(['low', 'possible', 'possible', 'likely']);
  });
});

describe('GET /api/sky', () => {
  const services = (extra: Partial<Services>): Services => ({
    readTasks: async () => ({ code: 'upstream-unavailable', message: 'test', retryable: true }),
    execute: async () => ({ code: 'invalid', message: 'test', retryable: false }),
    ...extra,
  });
  const app = (extra: Partial<Services>) => createApp({
    services: services(extra), appOrigin: 'https://vc.example.com', log: () => {},
    verify: async (token) => (token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false }),
  });
  const headers = { 'Cf-Access-Jwt-Assertion': 'good' };

  it('requires authentication, serves the provider read, and answers 404 when not wired', async () => {
    const readSky = vi.fn(async () => projectSky(parseKpBody(KP)!, new Date(NOW_MS), new Date(NOW_MS).toISOString()));
    expect((await app({ readSky }).request('/api/sky')).status).toBe(401);
    expect(readSky).not.toHaveBeenCalled();
    const response = await app({ readSky }).request('/api/sky', { headers });
    expect(response.status).toBe(200);
    expect(SkyResponse.parse(await response.json())).toMatchObject({ status: 'ok' });
    expect((await app({}).request('/api/sky', { headers })).status).toBe(404);
  });
});
