// Books route: GET /api/books through createApp + the real service + InMemoryStore.
import { BooksResponse, MAX_NOTE_BYTES } from '@vault-companion/contracts';
import { createBooksService, createCommandService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-b3d9';
const fixture =
  '---\n' +
  'type: book\n' +
  'status: reading\n' +
  'author: ' + SENTINEL + '\n' +
  'totalPages: 100\n' +
  '---\n' +
  '# Synthetic Book\n' +
  '\n' +
  '## Progress\n' +
  '- 2026-10-01: p. 10\n' +
  '\n' +
  '## Reflections\n' +
  '### 2026-10-02\n' +
  SENTINEL + ' reflection\n';
const BOOK = 'Books/Synthetic Book.md';
const ACCOUNT = 'a'.repeat(64);

let logs: LogRecord[];
let printed: unknown[][];

beforeEach(() => {
  logs = [];
  printed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
});
afterEach(() => vi.restoreAllMocks());

function makeApp(store: InMemoryStore, wired = true) {
  const commands = createCommandService({ store, now: () => new Date('2026-10-05T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const services: Services = wired ? { ...commands, ...createBooksService({ store }) } : commands;
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
}
const get = (store: InMemoryStore, token = 'good', wired = true) =>
  makeApp(store, wired).request('/api/books', { headers: { 'Cf-Access-Jwt-Assertion': token } });
const leaked = () => (JSON.stringify(logs) + JSON.stringify(printed)).includes(SENTINEL)
  || JSON.stringify(logs).includes('Books/')
  || JSON.stringify(logs).includes('Synthetic Book');

describe('GET /api/books', () => {
  it('returns the books card, no-store, and logs neither its text nor its path', async () => {
    const store = await InMemoryStore.create({ [BOOK]: fixture });
    const res = await get(store);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(BooksResponse.parse(await res.json())).toMatchObject({
      status: 'ok',
      books: [{ title: 'Synthetic Book', author: SENTINEL, totalPages: 100, currentPage: 10, status: 'reading', lastRead: '2026-10-01', reflections: [{ date: '2026-10-02' }] }],
    });
    expect(logs.at(-1)).toMatchObject({ route: '/api/books', status: 200, commitSha: store.headCommit });
    expect(logs.at(-1)!.pathHash).toBeUndefined();
    expect(leaked()).toBe(false);
  });

  it('empty vault ⇒ an empty list, not absent', async () => {
    const res = await get(await InMemoryStore.create({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', books: [] });
  });

  it('too large ⇒ typed refusal, logged by code only', async () => {
    const big = `${SENTINEL}`.padEnd(MAX_NOTE_BYTES + 1, 'x');
    const res = await get(await InMemoryStore.create({ [BOOK]: big }));
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'refused:too-large' });
    expect(logs.at(-1)).toMatchObject({ errorCode: 'books:refused:too-large' });
    expect(leaked()).toBe(false);
  });

  it('upstream unavailable ⇒ 503 retryable', async () => {
    const store = await InMemoryStore.create({ [BOOK]: fixture });
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
