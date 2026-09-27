import { LinkedNoteResponse, SCOUT_STATUS_DIR, ScoutsResponse } from '@vault-companion/contracts';
import { createCommandService, createScoutService, StoreUnavailable, type VaultStore } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { GitHubContentsStore } from '@vault-companion/github';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import type { LogRecord } from './log.ts';

const SENTINEL = 'SENTINEL-scout-9c1e';
const FILE = `${SCOUT_STATUS_DIR}/city-events.json`;
const OUTPUT = `Events/${SENTINEL}.md`;
const fixture = {
  schemaVersion: 1, scoutId: 'city-events', displayName: 'City events', schedule: 'daily 06:50', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-27T06:50:02+02:00', lastSuccessAt: null, runStatus: 'failed', sources: null, aiHealth: null,
  findings: null, added: null, errors: 1, lastError: 'runner could not start', latestOutput: null,
  history: [{ at: '2026-09-27T06:50:02+02:00', status: 'failed', findings: null }],
};
const seed = () => InMemoryStore.create({ [FILE]: JSON.stringify({ ...fixture, lastError: SENTINEL, latestOutput: OUTPUT }), [OUTPUT]: `# ${SENTINEL}\n` });
const headers = { 'Cf-Access-Jwt-Assertion': 'good', 'X-VC-Scout': 'city-events' };
afterEach(() => vi.restoreAllMocks());

function stack(store: VaultStore, wired = true) {
  const logs: LogRecord[] = [];
  const printed: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void printed.push(args));
  const app = createApp({
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false },
    appOrigin: 'https://vc.example.com',
    services: { ...createCommandService({ store, now: () => new Date('2026-09-27T12:00:00Z'), timeZone: 'Europe/Copenhagen' }), ...(wired ? createScoutService({ store, now: () => new Date('2026-09-27T12:00:00Z') }) : {}) },
    log: (record) => logs.push(record),
  });
  return { app, logs, printed };
}

describe('scout worker routes', () => {
  it('GET /api/scouts returns validated status with no caching or text in logs', async () => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const res = await app.request('/api/scouts', { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(ScoutsResponse.parse(await res.json())).toMatchObject({ now: '2026-09-27T12:00:00.000Z', scouts: [{ state: 'ok', status: { lastError: SENTINEL } }] });
    expect(logs.at(-1)).toMatchObject({ route: '/api/scouts', commitSha: store.headCommit, status: 200 });
    expect(JSON.stringify([logs, printed])).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SCOUT_STATUS_DIR);
    expect(store.writeCalls).toBe(0);
  });

  it('GET /api/scouts/output serves the server-selected note, ignoring a query path', async () => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const res = await app.request('/api/scouts/output?path=Tools/secret.md', { headers });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(LinkedNoteResponse.parse(await res.json())).toMatchObject({ status: 'ok', path: OUTPUT, markdown: `# ${SENTINEL}\n` });
    expect(logs.at(-1)).toMatchObject({ route: '/api/scouts/output', commitSha: store.headCommit, status: 200 });
    expect(JSON.stringify([logs, printed])).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain('Tools');
    expect(store.writeCalls).toBe(0);
  });

  it.each(['/api/scouts', '/api/scouts/output'])('%s requires auth, maps upstream errors, and has no unwired route', async (path) => {
    const store = await seed();
    const { app, logs, printed } = stack(store);
    const head = vi.spyOn(store, 'head');
    for (const token of ['', 'bad']) {
      const res = await app.request(path, { headers: { ...headers, 'Cf-Access-Jwt-Assertion': token } });
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(head).not.toHaveBeenCalled();
    head.mockRejectedValue(new StoreUnavailable(SENTINEL));
    const res = await app.request(path, { headers });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(logs.at(-1)?.errorCode).toBe('upstream-unavailable');
    expect(JSON.stringify([logs, printed])).not.toContain(SENTINEL);
    expect((await stack(store, false).app.request(path, { headers })).status).toBe(404);
  });

  it.each(['', '../city-events', 'City-events', '-city', 'x'.repeat(65), 'city_events'])('rejects malformed header %j before any read', async (id) => {
    const store = await seed();
    const { app } = stack(store);
    expect((await app.request('/api/scouts/output', { headers: { ...headers, 'X-VC-Scout': id } })).status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('requires the scout header and logs typed refusal by code only', async () => {
    const store = await seed();
    const { app, logs } = stack(store);
    expect((await app.request('/api/scouts/output', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } })).status).toBe(400);
    expect(store.calls).toEqual([]);
    const res = await app.request('/api/scouts/output', { headers: { ...headers, 'X-VC-Scout': 'unknown' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'refused', code: 'not-found' });
    expect(logs.at(-1)?.errorCode).toBe('scout-output:not-found');
  });
});

describe('scout output through the production GitHub adapter', () => {
  it.each(['Root.md', 'Events/note.md'])('proves regular files and pinned GET-only budget for %s', async (path) => {
    const x = 'a'.repeat(40);
    const statusSha = 'b'.repeat(40);
    const noteSha = 'c'.repeat(40);
    const calls: string[] = [];
    const dir = path.includes('/') ? 'Events' : '';
    const content = JSON.stringify({ ...fixture, latestOutput: path });
    let noteMode = '100644';
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const route = decodeURIComponent(url.pathname.replace('/repos/o/r', '')) + url.search;
      calls.push(`${init?.method} ${route}`);
      let body: unknown;
      if (route === '/git/ref/heads/main') body = { object: { sha: x } };
      else if (route === `/git/trees/${x}:${SCOUT_STATUS_DIR}?recursive=1`) body = { tree: [{ path: 'city-events.json', type: 'blob', mode: '100644', sha: statusSha }] };
      else if (route === `/contents/${FILE}?ref=${x}`) body = { type: 'file', sha: statusSha, size: content.length, encoding: 'base64', content: btoa(content) };
      else if (route === `/git/trees/${x}${dir ? `:${dir}` : ''}?recursive=1`) body = { tree: [{ path: dir ? 'note.md' : path, type: 'blob', mode: noteMode, sha: noteSha }] };
      else if (route === `/contents/${path}?ref=${x}`) body = { type: 'file', sha: noteSha, size: 7, encoding: 'base64', content: btoa('# note\n') };
      else throw new Error(`unexpected request ${route}`);
      return new Response(JSON.stringify(body));
    });
    const make = () => stack(new GitHubContentsStore({ owner: 'o', repo: 'r', token: async () => 'synthetic', fetch: fakeFetch })).app;
    expect(await (await make().request('/api/scouts/output', { headers })).json()).toMatchObject({ status: 'ok', path, markdown: '# note\n', revision: x });
    expect(calls).toHaveLength(5); // head + status listing + status + output listing + output
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
    noteMode = '120000';
    calls.length = 0;
    expect(await (await make().request('/api/scouts/output', { headers })).json()).toMatchObject({ status: 'refused', code: 'not-found' });
    expect(calls).toHaveLength(4);
  });
});
