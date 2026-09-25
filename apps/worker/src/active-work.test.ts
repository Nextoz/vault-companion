// Active Work route: GET /api/active-work through createApp + the real service + InMemoryStore.
// Auth like /api/tasks, `Cache-Control: no-store`, and no card text or path in any log or console output.
import { ACTIVE_WORK_PATH, ActiveWorkResponse, MAX_NOTE_BYTES } from '@vault-companion/contracts';
import { createActiveWorkService, createCommandService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-a7c1';
const ACCOUNT = 'a'.repeat(64);
const TODO = 'Tasks/To-Do List.md';

let logs: LogRecord[];
let printed: unknown[][];

beforeEach(() => {
  logs = [];
  printed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
});
afterEach(() => vi.restoreAllMocks());

function makeApp(store: InMemoryStore, wired = true) {
  const commands = createCommandService({ store, now: () => new Date('2026-09-24T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const services: Services = wired ? { ...commands, ...createActiveWorkService({ store }) } : commands;
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
}
const get = (store: InMemoryStore, token = 'good', wired = true) =>
  makeApp(store, wired).request('/api/active-work', { headers: { 'Cf-Access-Jwt-Assertion': token } });
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL) || JSON.stringify(logs).includes('Active Work');

describe('GET /api/active-work', () => {
  it('returns the card, no-store, and logs neither its text nor its path', async () => {
    const store = await InMemoryStore.create({ [TODO]: '', [ACTIVE_WORK_PATH]: `# ${SENTINEL}\n` });
    const res = await get(store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(ActiveWorkResponse.parse(await res.json())).toMatchObject({ status: 'ok', markdown: `# ${SENTINEL}\n` });
    expect(logs.at(-1)).toMatchObject({ route: '/api/active-work', status: 200, commitSha: store.headCommit });
    expect(logs.at(-1)!.pathHash).toBeUndefined();
    expect(leaked()).toBe(false);
  });

  it('absent file ⇒ 200 { status: absent }', async () => {
    const res = await get(await InMemoryStore.create({ [TODO]: '' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'absent' });
  });

  it('too large ⇒ typed refusal, logged by code only', async () => {
    const big = `${SENTINEL}`.padEnd(MAX_NOTE_BYTES + 1, 'x');
    const res = await get(await InMemoryStore.create({ [ACTIVE_WORK_PATH]: big }));
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'too-large' });
    expect(logs.at(-1)).toMatchObject({ errorCode: 'active-work:too-large' });
    expect(leaked()).toBe(false);
  });

  it('upstream unavailable ⇒ 503 retryable', async () => {
    const store = await InMemoryStore.create({ [ACTIVE_WORK_PATH]: `${SENTINEL}\n` });
    store.listFiles = async () => {
      throw new StoreUnavailable('down');
    };
    const res = await get(store);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(leaked()).toBe(false);
  });

  it.each(['bad', ''])('401 without a valid Access token (%j), nothing read', async (token) => {
    const store = await InMemoryStore.create({ [ACTIVE_WORK_PATH]: `${SENTINEL}\n` });
    let reads = 0;
    const real = store.head.bind(store);
    store.head = async () => {
      reads++;
      return real();
    };
    const res = await get(store, token);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SENTINEL);
    expect(reads).toBe(0);
  });

  it('404 when the service is not wired', async () => {
    expect((await get(await InMemoryStore.create({}), 'good', false)).status).toBe(404);
  });
});
