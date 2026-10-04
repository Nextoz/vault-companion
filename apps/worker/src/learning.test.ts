// Learning route: GET /api/learning through createApp + the real service + InMemoryStore.
import { LEARNING_PATH, LearningResponse, MAX_NOTE_BYTES } from '@vault-companion/contracts';
import { createCommandService, createLearningService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-a7c1';
const fixture = `## Kinds\n| id | Name | Score means | Status |\n| --- | --- | --- | --- |\n| dictation | Dictation | accuracy | active |\n\n## Log\n| Date | Kind | Min | Score | Detail | Topic or source | Note |\n| --- | --- | --- | --- | --- | --- | --- |\n| 2026-09-20 | verbs | 10 | 5 | | ${SENTINEL} | |\n`;
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
  const services: Services = wired ? { ...commands, ...createLearningService({ store }) } : commands;
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
}
const get = (store: InMemoryStore, token = 'good', wired = true) =>
  makeApp(store, wired).request('/api/learning', { headers: { 'Cf-Access-Jwt-Assertion': token } });
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL) || JSON.stringify(logs).includes('Learning');

describe('GET /api/learning', () => {
  it('returns the card, no-store, and logs neither its text nor its path', async () => {
    const store = await InMemoryStore.create({ [TODO]: '', [LEARNING_PATH]: fixture });
    const res = await get(store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(LearningResponse.parse(await res.json())).toMatchObject({ status: 'ok', kinds: [{ id: 'dictation' }], rows: [{ topic: SENTINEL }] });
    expect(logs.at(-1)).toMatchObject({ route: '/api/learning', status: 200, commitSha: store.headCommit });
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
    const res = await get(await InMemoryStore.create({ [LEARNING_PATH]: big }));
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'refused:too-large' });
    expect(logs.at(-1)).toMatchObject({ errorCode: 'learning:refused:too-large' });
    expect(leaked()).toBe(false);
  });

  it('upstream unavailable ⇒ 503 retryable', async () => {
    const store = await InMemoryStore.create({ [LEARNING_PATH]: `${SENTINEL}\n` });
    store.listFiles = async () => { throw new StoreUnavailable('down'); };
    const res = await get(store);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect(leaked()).toBe(false);
  });

  it('404 when the service is not wired', async () => {
    expect((await get(await InMemoryStore.create({}), 'good', false)).status).toBe(404);
  });
});
