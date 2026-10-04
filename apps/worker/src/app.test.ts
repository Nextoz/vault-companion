import { AiBudgetResponse, AiUsageResponse, MorningBriefResponse } from '@vault-companion/contracts';
import type { ApiError, Command, Receipt } from '@vault-companion/contracts';
import { AI_USAGE_PATH, createAiUsageReadService } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
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
      expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=(self), payment=()');
    }
  });
  it('reports the same Worker time in Server-Timing as in the log, and nothing else there', async () => {
    const res = await makeApp().request('/api/session');
    expect(res.headers.get('Server-Timing')).toBe(`app;dur=${logs.at(-1)!.durationMs}`);
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

describe('GET /api/morning-brief (MB2)', () => {
  const sample = (): MorningBriefResponse => MorningBriefResponse.parse({
    revision: '4'.repeat(40),
    date: '2026-10-02',
    generatedAt: '2026-10-02T04:31:00+02:00',
    source: 'model',
    unavailable: [],
    brief: { source: 'model', dayLine: `${SENTINEL} on the card`, gaps: [], todos: [{ id: 1, text: 'Pay ${SENTINEL}', due: null, bill: false }] },
  });

  function app(readMorningBrief?: Services['readMorningBrief']) {
    const services: Services = {
      async readTasks() { return { code: 'upstream-unavailable', message: 'x', retryable: true }; },
      async execute() { return receipt; },
      ...(readMorningBrief ? { readMorningBrief } : {}),
    };
    return createApp({
      verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
      appOrigin: ORIGIN,
      services,
      log: (r) => logs.push(r),
    });
  }
  const get = (readMorningBrief?: Services['readMorningBrief']) =>
    app(readMorningBrief).request('/api/morning-brief', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });

  it('404s without a service, and logs nothing from the brief', async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it.each([
    [{ code: 'not-found', retryable: false }, 404],
    [{ code: 'invalid', retryable: false }, 400],
    [{ code: 'upstream-unavailable', retryable: true }, 503],
  ] as const)('maps %o to %i', async (error, status) => {
    const res = await get(async () => ({ ...error, message: 'm' }));
    expect(res.status).toBe(status);
    expect(logs.at(-1)).toMatchObject({ errorCode: error.code });
  });

  it('returns the brief and logs only the revision', async () => {
    const res = await get(async () => sample());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sample());
    expect(logs.at(-1)).toMatchObject({ commitSha: '4'.repeat(40) });
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });
});

describe('GET /api/ai-budget (AB2)', () => {
  const sample = (): AiBudgetResponse => AiBudgetResponse.parse({
    revision: '5'.repeat(40),
    generatedAt: '2026-10-03T06:31:00+02:00',
    providers: [{ id: 'claude', label: `${SENTINEL} weekly`, kind: 'percent', value: 58, limit: 100, unit: null, resetsAt: null, history: null }],
    freeRamGb: 12.5,
  });

  function app(readAiBudget?: Services['readAiBudget']) {
    const services: Services = {
      async readTasks() { return { code: 'upstream-unavailable', message: 'x', retryable: true }; },
      async execute() { return receipt; },
      ...(readAiBudget ? { readAiBudget } : {}),
    };
    return createApp({
      verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
      appOrigin: ORIGIN,
      services,
      log: (r) => logs.push(r),
    });
  }
  const get = (readAiBudget?: Services['readAiBudget']) =>
    app(readAiBudget).request('/api/ai-budget', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });

  it('404s without a service, and logs nothing from the budget', async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it.each([
    [{ code: 'not-found', retryable: false }, 404],
    [{ code: 'invalid', retryable: false }, 400],
    [{ code: 'upstream-unavailable', retryable: true }, 503],
  ] as const)('maps %o to %i', async (error, status) => {
    const res = await get(async () => ({ ...error, message: 'm' }));
    expect(res.status).toBe(status);
    expect(logs.at(-1)).toMatchObject({ errorCode: error.code });
  });

  it('returns the budget and logs only the revision', async () => {
    const res = await get(async () => sample());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sample());
    expect(logs.at(-1)).toMatchObject({ commitSha: '5'.repeat(40) });
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });
});

describe('GET /api/ai-usage (AB3a)', () => {
  const day = (over: Record<string, unknown> = {}) => ({
    date: '2026-10-01',
    calls: 3,
    inputTokens: 100,
    outputTokens: 200,
    cacheWriteTokens: 10,
    cacheReadTokens: 20,
    cost: 0.42,
    ...over,
  });
  const provider = (over: Record<string, unknown> = {}) => ({ label: `${SENTINEL} usage`, days: [day()], ...over });
  const fileBytes = (providers: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    new TextEncoder().encode(JSON.stringify({ schema: 1, generatedAt: '2026-10-04T06:31:00+02:00', providers, ...over }));

  const sample = (): AiUsageResponse => AiUsageResponse.parse({
    revision: '6'.repeat(40),
    generatedAt: '2026-10-04T06:31:00+02:00',
    providers: { claude: { label: `${SENTINEL} usage`, days: [day()] } },
    skipped: 0,
  });

  function app(readAiUsage?: Services['readAiUsage']) {
    const services: Services = {
      async readTasks() { return { code: 'upstream-unavailable', message: 'x', retryable: true }; },
      async execute() { return receipt; },
      ...(readAiUsage ? { readAiUsage } : {}),
    };
    return createApp({
      verify: async (t) => (t === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
      appOrigin: ORIGIN,
      services,
      log: (r) => logs.push(r),
    });
  }
  const get = (readAiUsage?: Services['readAiUsage']) =>
    app(readAiUsage).request('/api/ai-usage', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });

  it('404s without a service, and logs nothing from the usage file', async () => {
    const res = await get();
    expect(res.status).toBe(404);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  it.each([
    [{ code: 'not-found', retryable: false }, 404],
    [{ code: 'invalid', retryable: false }, 400],
    [{ code: 'upstream-unavailable', retryable: true }, 503],
  ] as const)('maps %o to %i', async (error, status) => {
    const res = await get(async () => ({ ...error, message: 'm' }));
    expect(res.status).toBe(status);
    expect(logs.at(-1)).toMatchObject({ errorCode: error.code });
  });

  it('returns the summary and logs only the revision', async () => {
    const res = await get(async () => sample());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sample());
    expect(logs.at(-1)).toMatchObject({ commitSha: '6'.repeat(40) });
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  });

  // End-to-end over the real domain reader and an in-memory vault: the route must read the fixed file and keep
  // per-entry isolation (one malformed provider or day never hides the rest).
  const getFromVault = async (files: Record<string, string | Uint8Array>) =>
    app(createAiUsageReadService({ store: await InMemoryStore.create(files) }).readAiUsage)
      .request('/api/ai-usage', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });

  it('reads the fixed file and returns the validated projection (ok)', async () => {
    const res = await getFromVault({ [AI_USAGE_PATH]: fileBytes({ claude: provider() }) });
    expect(res.status).toBe(200);
    const body = AiUsageResponse.parse(await res.json());
    expect(body).toMatchObject({ skipped: 0, providers: { claude: { days: [{ calls: 3 }] } } });
  });

  it('404s when the fixed file is missing (missing)', async () => {
    const res = await getFromVault({ 'AI/Usage/decoy.json': fileBytes({ claude: provider() }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not-found' });
  });

  it('drops one malformed provider, keeps the rest, and keeps an unknown provider id', async () => {
    const res = await getFromVault({ [AI_USAGE_PATH]: fileBytes({ claude: provider(), mystery: provider({ label: 'Unknown vendor' }), broken: { days: 'nope' }, codex: provider() }) });
    expect(res.status).toBe(200);
    const body = AiUsageResponse.parse(await res.json());
    expect(body.skipped).toBe(1);
    expect(Object.keys(body.providers)).toEqual(['claude', 'mystery', 'codex']);
  });

  it('ignores unknown extra fields', async () => {
    const res = await getFromVault({ [AI_USAGE_PATH]: fileBytes({ claude: provider({ extra: true, days: [day({ extra: 1 })] }) }, { extraTop: 1 }) });
    expect(res.status).toBe(200);
    const body = AiUsageResponse.parse(await res.json());
    expect(body.skipped).toBe(0);
    expect(body.providers.claude).not.toHaveProperty('extra');
  });
});