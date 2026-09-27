// Completion history route (ADR-0021): GET /api/history through createApp + the real service + InMemoryStore.
// Auth like /api/active-work, `Cache-Control: no-store`, and no task text in any log or console output.
import { ACTIVE_WORK_PATH, HistoryResponse } from '@vault-companion/contracts';
import { createCommandService, createHistoryService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-h3d9';
const TODO = 'Tasks/To-Do List.md';
const now = () => new Date('2026-09-26T12:00:00Z');

let logs: LogRecord[];
let printed: unknown[][];

beforeEach(() => {
  logs = [];
  printed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
});
afterEach(() => vi.restoreAllMocks());

function get(store: InMemoryStore, token = 'good', wired = true) {
  const commands = createCommandService({ store, now, timeZone: 'Europe/Copenhagen' });
  const services: Services = wired ? { ...commands, ...createHistoryService({ store, now, timeZone: 'Europe/Copenhagen' }) } : commands;
  const app = createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
  return app.request('/api/history', { headers: { 'Cf-Access-Jwt-Assertion': token } });
}
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL);
const files = {
  [TODO]: `## Open\n## Done\n- [x] Water the plants ${SENTINEL} #todo ✅ 2026-09-25\n`,
  [ACTIVE_WORK_PATH]: `## Now\n## Dropped or done\n- [x] **Garden plan:** ${SENTINEL} ✅ 2026-09-26\n`,
};

describe('GET /api/history', () => {
  it('returns both sources newest first, no-store, and logs no task text', async () => {
    const store = await InMemoryStore.create(files);
    const res = await get(store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = HistoryResponse.parse(await res.json());
    expect(body.items.map((i) => [i.source, i.doneDate])).toEqual([['active-work', '2026-09-26'], ['todo', '2026-09-25']]);
    expect(logs.at(-1)).toMatchObject({ route: '/api/history', status: 200, commitSha: store.headCommit });
    expect(leaked()).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await get(await InMemoryStore.create(files), 'bad');
    expect(res.status).toBe(401);
    expect(leaked()).toBe(false);
  });

  it('store outage ⇒ 503 upstream-unavailable; unwired ⇒ 404', async () => {
    const store = await InMemoryStore.create(files);
    store.readFile = async () => {
      throw new StoreUnavailable('down');
    };
    const res = await get(store);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect((await get(await InMemoryStore.create(files), 'good', false)).status).toBe(404);
  });
});
