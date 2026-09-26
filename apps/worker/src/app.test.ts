import type { ApiError, Command, Receipt } from '@vault-companion/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, statusFor, type Services } from './app.ts';
import { sanitize, type LogRecord } from './log.ts';

const ORIGIN = 'https://vc.example.com';
const SENTINEL = 'SENTINEL-7f3a-private-text';
const ACCOUNT = 'a'.repeat(64);
const SHA1 = '1'.repeat(40);

let logs: LogRecord[];
let executed: { command: Command; raw: unknown }[];
let nextResult: Receipt | ApiError;
let askedKnown: readonly string[] | null;

function makeApp() {
  const services: Services = {
    async readTasks(known) {
      askedKnown = known;
      return { code: 'upstream-unavailable', message: 'x', retryable: true };
    },
    async execute(command, raw) {
      executed.push({ command, raw });
      return nextResult;
    },
  };
  return createApp({
    verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: ORIGIN,
    services,
    log: (r) => logs.push(r),
  });
}

const captureNote = {
  schemaVersion: 1,
  operationId: '22222222-2222-4222-8222-222222222222',
  type: 'CaptureNote',
  occurredAt: '2026-09-24T21:00:00+02:00',
  baseRevision: SHA1,
  payload: { text: `${SENTINEL} first line\nmore ${SENTINEL}` },
};

const receipt: Receipt = {
  operationId: captureNote.operationId,
  status: 'applied',
  path: `Inbox/${SENTINEL} first line - 2026-09-24.md`,
  commitSha: '2'.repeat(40),
  blobSha: '3'.repeat(40),
  effect: { kind: 'note-captured', path: `Inbox/${SENTINEL} first line - 2026-09-24.md` },
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return makeApp().request('/api/commands', {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': 'good', Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  logs = [];
  executed = [];
  nextResult = receipt;
  askedKnown = null;
});

describe('GET /api/tasks known= (review O1)', () => {
  it('passes at most MAX_KNOWN (8) well-formed commits to the read, in the order asked', async () => {
    const shas = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(40, '0'));
    await makeApp().request(`/api/tasks?known=${['not-a-sha', ...shas].join(',')}`, { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(askedKnown).toEqual(shas.slice(0, 8));
  });
});

describe('authentication (A19)', () => {
  it.each(['/api/session', '/api/tasks'])('%s without a valid Access token is 401 with no detail', async (path) => {
    const res = await makeApp().request(path, { headers: { 'Cf-Access-Jwt-Assertion': 'bad' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'unauthorized', message: 'sign in required', retryable: false });
  });
  it('POST without a token is 401 even with correct origin headers, and nothing executes', async () => {
    const res = await post(captureNote, { 'Cf-Access-Jwt-Assertion': '' });
    expect(res.status).toBe(401);
    expect(executed).toHaveLength(0);
  });
  it('session returns the account key', async () => {
    const res = await makeApp().request('/api/session', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(await res.json()).toEqual({ accountKey: ACCOUNT });
  });
});

describe('CSRF / origin guard (T4)', () => {
  it.each([
    ['foreign Origin', { Origin: 'https://evil.example.com' }],
    ['missing Origin', { Origin: '' }],
    ['missing X-VC-Request', { 'X-VC-Request': '' }],
    ['form content type', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['text/plain', { 'Content-Type': 'text/plain' }],
  ])('%s ⇒ 403 and nothing executes', async (_n, h) => {
    const res = await post(captureNote, h);
    expect(res.status).toBe(403);
    expect(executed).toHaveLength(0);
  });
  it.each([
    ['missing X-VC-Account', { 'X-VC-Account': '' }],
    ['another account', { 'X-VC-Account': 'b'.repeat(64) }],
  ])('%s ⇒ 409 account-mismatch and nothing executes (review A7)', async (_n, h) => {
    const res = await post(captureNote, h);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'account-mismatch', retryable: false });
    expect(executed).toHaveLength(0);
  });
  it('GET cannot mutate', async () => {
    const res = await makeApp().request('/api/commands', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(404);
  });
});

describe('validation', () => {
  it('rejects malformed JSON, oversize bodies and unknown fields without echoing values', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ ...captureNote, payload: { text: 'x'.repeat(70_000) } })).status).toBe(400);
    const res = await post({ ...captureNote, payload: { text: SENTINEL, extra: SENTINEL } });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SENTINEL);
    expect(executed).toHaveLength(0);
  });
  it('passes the exact parsed body as raw (for the payload hash)', async () => {
    await post(captureNote);
    expect(executed[0]!.raw).toEqual(captureNote);
  });
});

describe('responses', () => {
  it('sets no-store and the security headers on every response, including errors', async () => {
    for (const res of [await post(captureNote), await makeApp().request('/api/session')]) {
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
  it.each([
    ['conflict:task-changed', 409],
    ['refused:recurring', 422],
    ['operation-id-reused', 409],
    ['dedupe-unknown', 409],
    ['clock-skew', 400],
    ['upstream-unavailable', 503],
  ] as const)('maps %s to %i', (code, status) => {
    expect(statusFor(code)).toBe(status);
  });
});

describe('runtime log allowlist (review A10: guards log.ts sanitize filter)', () => {
  it('drops every key that is not allowlisted, even when a caller casts around the type', () => {
    const smuggled = { requestId: 'r', method: 'POST', route: '/api/commands', status: 200, durationMs: 1, text: SENTINEL, body: { t: SENTINEL }, path: SENTINEL } as unknown as LogRecord;
    const out = sanitize(smuggled);
    expect(Object.keys(out).sort()).toEqual(['durationMs', 'method', 'requestId', 'route', 'status']);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });
});

describe('A18 log sentinel', () => {
  it('never logs task/note text or clear-text paths, on success and on error', async () => {
    await post(captureNote);
    nextResult = { code: 'conflict:task-changed', message: `changed: ${SENTINEL}`, retryable: false };
    await post({ ...captureNote, operationId: '33333333-3333-4333-8333-333333333333' });
    await post({ ...captureNote, payload: { text: SENTINEL, bogus: SENTINEL } });
    expect(logs).toHaveLength(3);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(SENTINEL);
    expect(logs[0]).toMatchObject({ commandType: 'CaptureNote', status: 200, commitSha: '2'.repeat(40) });
    expect(logs[0]!.pathHash).toMatch(/^[0-9a-f]{16}$/);
    expect(logs[1]).toMatchObject({ errorCode: 'conflict:task-changed', status: 409 });
  });
});
