import { SessionResponse } from '@vault-companion/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJson, getTasks, READ_TIMEOUT_MS } from './api.ts';

const ok = { accountKey: 'a'.repeat(64) };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fetch that never answers until its signal aborts, like a hung connection. */
const hanging = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

describe('getJson: bounded session and task reads (P4-B)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers ok for a valid reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(ok)));
    await expect(getJson('/api/session', SessionResponse)).resolves.toEqual({ kind: 'ok', data: ok });
  });

  it('gives up on a read the server never answers after the fixed timeout, as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(hanging));
    const out = getJson('/api/session', SessionResponse);
    let settled = false;
    void out.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(out).resolves.toEqual({ kind: 'error', message: 'The server did not answer in time.' });
  });

  it('bounds the body too: headers in time, body never', async () => {
    // Never enqueues, never closes, and ignores the abort signal.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 })));
    const out = getJson('/api/session', SessionResponse);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await expect(out).resolves.toMatchObject({ kind: 'error' });
  });

  it('maps a network failure to offline, a 5xx or malformed reply to error, 401/403/opaque redirect to signed-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(getJson('/api/session', SessionResponse)).resolves.toEqual({ kind: 'offline' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'x' }, 500)));
    await expect(getJson('/api/session', SessionResponse)).resolves.toMatchObject({ kind: 'error' });

    vi.stubGlobal('fetch', vi.fn(async () => json({ nope: true })));
    await expect(getJson('/api/session', SessionResponse)).resolves.toMatchObject({ kind: 'error' });

    for (const status of [401, 403]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
      await expect(getJson('/api/session', SessionResponse)).resolves.toEqual({ kind: 'signed-out' });
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'opaqueredirect', status: 0, ok: false }) as Response));
    await expect(getJson('/api/session', SessionResponse)).resolves.toEqual({ kind: 'signed-out' });
  });

  it('clears its timer once answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(ok)));
    await getJson('/api/session', SessionResponse);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('getTasks: forward compatible with a newer server', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores an unknown top-level field instead of reporting an unexpected reply', async () => {
    const read = { vault: null, revision: 'a'.repeat(40), blobSha: 'b'.repeat(40), today: '2026-09-26', timeZone: 'Europe/Copenhagen',
      writeBlock: null, known: {}, todayTasks: [], overdue: [], allOpen: [], doneToday: [] };
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...read, addedLater: { any: 1 } })));
    await expect(getTasks([])).resolves.toEqual({ kind: 'ok', data: read });
  });
});
