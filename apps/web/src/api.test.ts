import { SessionResponse } from '@vault-companion/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askFollowUp, FOLLOW_UP_TIMEOUT_MS, getJson, getScoutsShared, getTasks, READ_TIMEOUT_MS } from './api.ts';
import { clearReadTimings, readTimings } from './timings.ts';

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

  it('records the read time and the Worker time per route, without the query', async () => {
    clearReadTimings();
    const res = json(ok);
    res.headers.set('Server-Timing', 'app;dur=42');
    vi.stubGlobal('fetch', vi.fn(async () => {
      vi.advanceTimersByTime(250); // the phone's view of the round trip
      return res;
    }));
    await getJson('/api/session?known=secret', SessionResponse);
    expect(readTimings()).toEqual([expect.objectContaining({ route: '/api/session', totalMs: 250, serverMs: 42 })]);
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

describe('getScoutsShared: one scouts read shared by callers in the same task (PERF-B)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes one fetch for same-task callers and a second for a caller after a task boundary', async () => {
    const fetchMock = vi.fn(async () => json({ revision: 'a'.repeat(40), now: '2026-10-16T09:41:00Z', scouts: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const first = getScoutsShared();
    const second = getScoutsShared();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const answers = await Promise.all([first, second]);
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ kind: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await getScoutsShared();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('askFollowUp: one AI question per saved reflection (READ1-B)', () => {
  const request = { title: 'Synthetic Book', date: '2026-10-05', ordinal: 2 };
  const account = 'a'.repeat(64);
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('returns the one question on a valid reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ question: 'What did that change for you?' })));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'ok', data: { question: 'What did that change for you?' } });
  });

  it('carries the same guards as askJev, with the reflection selection in the body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ question: 'Is that so?' }));
    vi.stubGlobal('fetch', fetchMock);
    await askFollowUp(request, account);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/books/follow-up');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-VC-Request': '1', 'X-VC-Account': account });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('shows an honest message when the day is used up (429)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'follow-up-rate-limited', message: 'Too many.', retryable: false }, 429)));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'error', message: "Today's limit of AI questions is used up." });
  });

  it('shows an honest message when AI questions are not set up (503)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'follow-up-unavailable', message: 'Not configured.', retryable: false }, 503)));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'error', message: 'AI questions are not set up.' });
  });

  it('shows an honest message when the AI returned nothing usable (502)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'follow-up-bad-output', message: 'Bad output.', retryable: false }, 502)));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'error', message: 'The AI did not return a question. Try again.' });
  });

  it('gives up with an honest message after the fixed timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(hanging));
    const out = askFollowUp(request, account);
    let settled = false;
    void out.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(FOLLOW_UP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(out).resolves.toEqual({ kind: 'error', message: 'The AI question did not arrive in time. Try again.' });
  });

  it('treats a malformed 200 body as an error, never a question', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ nope: true })));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'error', message: 'Unexpected reply from the server.' });
  });

  it('maps a network failure to offline and the 409 guard to the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'offline' });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'account-mismatch', message: 'this action was saved under a different sign-in', retryable: false }, 409)));
    await expect(askFollowUp(request, account)).resolves.toEqual({ kind: 'error', message: 'this action was saved under a different sign-in' });
  });
});
