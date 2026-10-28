import { HEALTH_DAILY_CSV, HEALTH_VITALS_DAILY_CSV, HealthResponse, RingDayResponse, ringSlotsPath } from '@vault-companion/contracts';
import { createCommandService, createHealthService, RING_DAILY_HEADER, RING_METRICS, ringSlotHeader, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import type { LogRecord } from './log.ts';

const now = () => new Date('2026-10-28T12:00:00Z');
const daily = (date: string) => `${date},Wed,,,15,,,60,424242,,,,,1,0,0,0,1`;
const headers = { 'Cf-Access-Jwt-Assertion': 'good' };
function stack(store: InMemoryStore, wired = true) {
  const logs: LogRecord[] = [];
  const app = createApp({
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false },
    appOrigin: 'https://vc.example.com', log: (r) => logs.push(r),
    services: { ...createCommandService({ store, now, timeZone: 'Europe/Copenhagen' }), ...(wired ? createHealthService({ store, now }) : {}) },
  });
  return { app, logs };
}
describe('ring routes', () => {
  it('returns unreadable for a corrupt month without exposing file text', async () => {
    const store = await InMemoryStore.create({ [ringSlotsPath('2026-10')]: 'private-synthetic' });
    const { app, logs } = stack(store), res = await app.request('/api/health/ring?date=2026-10-28', { headers });
    expect(res.status).toBe(200); expect(RingDayResponse.parse(await res.json()).status).toBe('unreadable');
    expect(JSON.stringify(logs)).not.toContain('private-synthetic');
  });
  it('returns guarded slots and the exact night, with private data absent from logs', async () => {
    const store = await InMemoryStore.create({
      [ringSlotsPath('2026-10')]: `${ringSlotHeader(1)}\n2026-10-28T12:00:00+01:00,${RING_METRICS.map((m) => m.key === 'hr' ? '424242' : '').join(',')}\n`,
      [HEALTH_VITALS_DAILY_CSV]: `${RING_DAILY_HEADER}\n${daily('2026-10-28')}\n`,
    });
    const { app, logs } = stack(store), res = await app.request('/api/health/ring?date=2026-10-28', { headers });
    expect(res.status).toBe(200); expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(RingDayResponse.parse(await res.json())).toMatchObject({ status: 'ok', night: { date: '2026-10-28', avgHr: 424242, sleepStart: null } });
    expect(logs.at(-1)).toMatchObject({ commitSha: store.headCommit });
    expect(JSON.stringify(logs)).not.toMatch(/424242|Health\/Data|2026-10-28/); expect(store.writeCalls).toBe(0);
  });
  it('requires auth; validates dates; returns missing, 404 and sanitized 503', async () => {
    const store = await InMemoryStore.create({}), { app, logs } = stack(store), head = vi.spyOn(store, 'head');
    expect((await app.request('/api/health/ring?date=2026-10-28')).status).toBe(401); expect(head).not.toHaveBeenCalled();
    for (const suffix of ['', '?date=bad', '?date=2026-02-30', '?date=2026-10-29']) {
      const res = await app.request(`/api/health/ring${suffix}`, { headers }); expect(res.status).toBe(400); expect(await res.json()).toEqual({ error: 'invalid date' });
    }
    expect(head).not.toHaveBeenCalled();
    const missing = await app.request('/api/health/ring?date=2026-10-28', { headers });
    expect(RingDayResponse.parse(await missing.json()).status).toBe('missing');
    expect((await stack(store, false).app.request('/api/health/ring', { headers })).status).toBe(404);
    head.mockRejectedValue(new StoreUnavailable('private-synthetic'));
    expect((await app.request('/api/health/ring?date=2026-10-28', { headers })).status).toBe(503);
    expect(logs.at(-1)?.errorCode).toBe('upstream-unavailable'); expect(JSON.stringify(logs)).not.toContain('private-synthetic');
  });
  it.each(['ok', 'missing', 'unreadable', 'outage', 'future', 'bad-row'])('vitals %s leaves v1 fields unchanged', async (mode) => {
    const v1 = { [HEALTH_DAILY_CSV]: 'date,steps,headphone_min,first_move,last_move\n2026-10-27,5000,30,10:00,22:00\n' };
    const baselineStore = await InMemoryStore.create(v1);
    const baseline = await createHealthService({ store: baselineStore, now }).readHealth();
    const text = mode === 'unreadable' ? 'bad' : `${RING_DAILY_HEADER}\n${daily(mode === 'future' ? '2026-10-29' : '2026-10-25')}\n${mode === 'ok' ? daily('2026-10-29') + '\n' : mode === 'bad-row' ? 'bad\n' : ''}`;
    const store = await InMemoryStore.create({ ...v1, ...(mode === 'missing' ? {} : { [HEALTH_VITALS_DAILY_CSV]: text }) });
    if (mode === 'outage') {
      const read = store.readFile.bind(store);
      vi.spyOn(store, 'readFile').mockImplementation((path, rev) => path === HEALTH_VITALS_DAILY_CSV ? Promise.reject(new StoreUnavailable('private')) : read(path, rev));
    }
    const res = await stack(store).app.request('/api/health', { headers }); expect(res.status).toBe(200);
    const { vitals, revision: _revision, ...rest } = HealthResponse.parse(await res.json());
    const { vitals: _vitals, revision: _baseRevision, ...expected } = HealthResponse.parse(baseline);
    expect(rest).toEqual(expected);
    expect(vitals?.status).toBe(mode === 'future' ? 'missing' : ['outage', 'bad-row'].includes(mode) ? 'unreadable' : mode);
    if (mode === 'ok') expect(vitals).toMatchObject({ row: { date: '2026-10-25', sleepStart: null, restingHr: 60 }, daySlots: 100, staleDays: 3 });
    else expect(vitals).toMatchObject({ row: null, daySlots: null, staleDays: null });
  });
});
