// P4-A route: GET /api/linked-note through createApp + the real linked-note service + InMemoryStore.
// Auth like /api/tasks, `Cache-Control: no-store`, and no task text, note text or path in any log or console output.
import { encodeLinkedNoteHeader, LINKED_NOTE_HEADER, LinkedNoteResponse, TasksResponse, type LinkedNoteRequest } from '@vault-companion/contracts';
import { createCommandService, createLinkedNoteService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-4b2d';
const TODO = 'Tasks/To-Do List.md';
const ACCOUNT = 'a'.repeat(64);
const SEED = {
  [TODO]: `## Open\n\n- [ ] Read ${SENTINEL} [[Projects/${SENTINEL} Plan]] and [[Nowhere]] #todo\n\n## Done\n`,
  [`Projects/${SENTINEL} Plan.md`]: `# ${SENTINEL} first line\n\nBody ${SENTINEL}\n`,
};

let logs: LogRecord[];
let printed: unknown[][];
let store: InMemoryStore;

beforeEach(async () => {
  logs = [];
  printed = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a));
  store = await InMemoryStore.create(SEED);
});
afterEach(() => vi.restoreAllMocks());

function makeApp(withNotes = true) {
  const commands = createCommandService({ store, now: () => new Date('2026-09-24T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
  const services: Services = withNotes ? { ...commands, ...createLinkedNoteService({ store }) } : commands;
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: 'https://vc.example.com',
    services,
    log: (r) => logs.push(r),
  });
}

async function request(linkIndex: number): Promise<LinkedNoteRequest> {
  const res = await makeApp().request('/api/tasks', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
  const tasks = TasksResponse.parse(await res.json());
  return { taskLocator: tasks.allOpen[0]!.locator, linkIndex };
}

const get = (header: string | undefined, token = 'good', app = makeApp()) =>
  app.request('/api/linked-note', { headers: { 'Cf-Access-Jwt-Assertion': token, ...(header === undefined ? {} : { [LINKED_NOTE_HEADER]: header }) } });

describe('GET /api/linked-note', () => {
  it('returns the resolved note, no-store, and logs neither note text nor path', async () => {
    const res = await get(encodeLinkedNoteHeader(await request(0)));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    const body = LinkedNoteResponse.parse(await res.json());
    expect(body).toMatchObject({ status: 'ok', path: `Projects/${SENTINEL} Plan.md`, markdown: SEED[`Projects/${SENTINEL} Plan.md`] });
    const record = logs.find((l) => l.route === '/api/linked-note')!;
    expect(record).toMatchObject({ status: 200, commitSha: store.headCommit });
    expect(record.pathHash).toBeUndefined();
    expect(JSON.stringify(logs) + JSON.stringify(printed)).not.toContain(SENTINEL);
  });

  it('a refusal is a typed 200 answer, logged by code only', async () => {
    const res = await get(encodeLinkedNoteHeader(await request(1)));
    expect(LinkedNoteResponse.parse(await res.json())).toMatchObject({ status: 'refused', code: 'not-found' });
    expect(logs.at(-1)).toMatchObject({ route: '/api/linked-note', errorCode: 'linked-note:not-found' });
    expect(JSON.stringify(logs) + JSON.stringify(printed)).not.toContain(SENTINEL);
  });

  it.each([['bad'], ['']])('401 without a valid Access token (%j), nothing resolved', async (token) => {
    const header = encodeLinkedNoteHeader(await request(0));
    logs = [];
    const res = await get(header, token);
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).not.toContain(SENTINEL);
  });

  it.each([undefined, '', 'x', encodeLinkedNoteHeader({ linkIndex: 0 } as unknown as LinkedNoteRequest)])('400 for a missing or malformed request %j', async (header) => {
    const res = await get(header);
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a path in the query string is ignored: only the locator is resolved', async () => {
    const header = encodeLinkedNoteHeader(await request(1));
    const res = await makeApp().request(`/api/linked-note?path=${encodeURIComponent(`Projects/${SENTINEL} Plan.md`)}`, {
      headers: { 'Cf-Access-Jwt-Assertion': 'good', [LINKED_NOTE_HEADER]: header },
    });
    expect(LinkedNoteResponse.parse(await res.json())).toMatchObject({ status: 'refused', code: 'not-found' });
  });

  it('store outage ⇒ 503 retryable', async () => {
    const header = encodeLinkedNoteHeader(await request(0));
    store.readFile = async () => {
      const { StoreUnavailable } = await import('@vault-companion/domain');
      throw new StoreUnavailable('down');
    };
    const res = await get(header);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });

  it('404 when the service is not wired', async () => {
    const res = await get(encodeLinkedNoteHeader(await request(0)), 'good', makeApp(false));
    expect(res.status).toBe(404);
  });
});
