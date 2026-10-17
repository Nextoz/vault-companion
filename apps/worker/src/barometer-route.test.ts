import { BarometerResponse } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';

describe('GET /api/barometer', () => {
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
    const readBarometer = vi.fn(async () => BarometerResponse.parse({
      status: 'ok', now: '2026-10-17T06:45:00.000Z', fetchedAt: '2026-10-17T06:45:00.000Z', source: 'dmi', place: 'Trianglen',
      hPa: 1020.2, observedAt: '2026-10-17T06:40:00.000Z', hPaThreeHoursAgo: 1018.9, changeHpa: 1.3, trend: 'rising', zone: 'Fair',
    }));
    expect((await app({ readBarometer }).request('/api/barometer')).status).toBe(401);
    expect(readBarometer).not.toHaveBeenCalled();
    const response = await app({ readBarometer }).request('/api/barometer', { headers });
    expect(response.status).toBe(200);
    expect(BarometerResponse.parse(await response.json())).toMatchObject({ status: 'ok', hPa: 1020.2 });
    expect((await app({}).request('/api/barometer', { headers })).status).toBe(404);
  });
});
