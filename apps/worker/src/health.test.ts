import { HEALTH_DAILY_CSV, HealthHistoryResponse, HealthResponse } from '@vault-companion/contracts';
import { createCommandService, createHealthService, StoreUnavailable, type VaultStore } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import type { LogRecord } from './log.ts';

const NOW = new Date('2026-05-01T12:00:00Z'); // Copenhagen: 2026-05-01 -> shown day 2026-04-30.
const TZ = 'Europe/Copenhagen';
const SENTINEL = 424242; // flows into the response; must never reach a log record.
const HEADER = 'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h';

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + n * 86_400_000).toISOString().slice(0, 10);
}
const row = (date: string, steps: number) =>
  [date, 'Mon', String(steps), '1', '0', '0', '0', '11:00', '23:00', '0', '0', '60', '0', '0', '8'].join(',');
const seedCsv = (): string => {
  const days: string[] = [];
  for (let i = 1; i <= 20; i++) days.push(row(addDays('2026-04-30', -i), 5000));
  days.push(row('2026-04-30', SENTINEL));
  return [HEADER, ...days].join('\n') + '\n';
};
const seed = () => InMemoryStore.create({ [HEALTH_DAILY_CSV]: seedCsv() });
afterEach(() => vi.restoreAllMocks());

function stack(store: VaultStore, wired = true) {
  const logs: LogRecord[] = [];
  const printed: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
  const app = createApp({
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false },
    appOrigin: 'https://vc.example.com',
    services: {
      ...createCommandService({ store, now: () => NOW, timeZone: TZ }),
      ...(wired ? createHealthService({ store, now: () => NOW, timeZone: TZ }) : {}),
    },
    log: (record) => logs.push(record),
  });
  return { app, logs, printed };
}

describe('health worker route', () => {
  it('GET /api/health returns validated JSON with no caching and no value, row or path in logs', async () => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const res = await app.request('/api/health', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.day).toBe('2026-04-30');
    expect(body.metrics).toContainEqual(expect.objectContaining({ key: 'steps', value: SENTINEL }));
    expect(logs.at(-1)).toMatchObject({ route: '/api/health', commitSha: store.headCommit, status: 200 });
    const all = JSON.stringify([logs, printed]);
    expect(all).not.toContain(String(SENTINEL));
    expect(all).not.toContain(HEALTH_DAILY_CSV);
    expect(all).not.toContain('Health/Data');
    expect(store.writeCalls).toBe(0);
  });

  it('requires auth, maps a store outage by code only, and 404s without the service', async () => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const head = vi.spyOn(store, 'head');
    for (const token of ['', 'bad']) {
      const res = await app.request('/api/health', { headers: { 'Cf-Access-Jwt-Assertion': token } });
      expect(res.status).toBe(401);
    }
    expect(head).not.toHaveBeenCalled();
    head.mockRejectedValue(new StoreUnavailable('SENTINEL-health'));
    const res = await app.request('/api/health', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect(logs.at(-1)?.errorCode).toBe('upstream-unavailable');
    expect(JSON.stringify([logs, printed])).not.toContain('SENTINEL-health');
    expect((await stack(store, false).app.request('/api/health', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } })).status).toBe(404);
  });

  it('GET /api/health/history returns every day with no value, row or path in logs', async () => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const res = await app.request('/api/health/history', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = HealthHistoryResponse.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.days.at(-1)).toMatchObject({ date: '2026-04-30', steps: SENTINEL });
    expect(logs.at(-1)).toMatchObject({ route: '/api/health/history', commitSha: store.headCommit, status: 200 });
    const all = JSON.stringify([logs, printed]);
    expect(all).not.toContain(String(SENTINEL));
    expect(all).not.toContain(HEALTH_DAILY_CSV);
    expect(all).not.toContain('Health/Data');
    expect(store.writeCalls).toBe(0);
  });

  it('history requires user auth, 404s without the service, and maps a store outage by code only', async () => {
    const store = await seed();
    expect((await stack(store, false).app.request('/api/health/history', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } })).status).toBe(404);
    const { app, logs, printed } = stack(store);
    const head = vi.spyOn(store, 'head');
    expect((await app.request('/api/health/history')).status).toBe(401);
    expect(head).not.toHaveBeenCalled();
    head.mockRejectedValue(new StoreUnavailable('SENTINEL-health'));
    const res = await app.request('/api/health/history', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect(logs.at(-1)?.errorCode).toBe('upstream-unavailable');
    expect(JSON.stringify([logs, printed])).not.toContain('SENTINEL-health');
  });
});
