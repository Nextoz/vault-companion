import type { HealthIngestOutcome } from '@vault-companion/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createServiceTokenVerifier } from './auth.ts';
import type { LogRecord } from './log.ts';

const ACCOUNT = 'a'.repeat(64);
const EMAIL = 'owner@example.com';
const COMMON_NAME = 'health-ingest-shortcut';

let calls: string[] = [];
let logs: LogRecord[] = [];
let next: HealthIngestOutcome;

const okOutcome: HealthIngestOutcome = { ok: true, days: ['2026-09-29'], commitSha: '2'.repeat(40) };

function services(withIngest = true): Services {
  return {
    async readTasks() {
      return { code: 'upstream-unavailable', message: 'x', retryable: true };
    },
    async execute() {
      return { code: 'upstream-unavailable', message: 'x', retryable: true };
    },
    ...(withIngest
      ? {
          async ingestHealth(body: string) {
            calls.push(body);
            return next;
          },
        }
      : {}),
  };
}

function makeApp(withIngest = true) {
  return createApp({
    verify: async (token) => (token === 'user' ? { ok: true, email: EMAIL, accountKey: ACCOUNT } : { ok: false }),
    ...(withIngest
      ? {
          verifyIngest: async (token) =>
            token === 'ingest' ? { ok: true, commonName: COMMON_NAME } : { ok: false, reason: 'aud' },
        }
      : {}),
    appOrigin: 'https://vc.example.com',
    services: services(withIngest),
    log: (record) => {
      logs.push(record);
    },
  });
}

function post(path: string, token = 'ingest', body = '{}') {
  return makeApp().request(path, {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': 'application/json' },
    body,
  });
}

beforeEach(() => {
  calls = [];
  logs = [];
  next = okOutcome;
});

describe('POST /api/health/ingest route', () => {
  it('logs only the refusal reason code on a 401, never the token', async () => {
    const res = await post('/api/health/ingest', 'not-the-token');
    expect(res.status).toBe(401);
    expect(logs.at(-1)?.errorCode).toBe('health-ingest:auth:aud');
    expect(JSON.stringify(logs)).not.toContain('not-the-token');
  });

  it('skips user auth for the exact POST, verifies the service token, and returns days', async () => {
    const body = '{"schemaVersion":1}';
    const res = await post('/api/health/ingest', 'ingest', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, days: ['2026-09-29'] });
    expect(calls).toEqual([body]);
  });

  it('maps a domain refusal to the custom error shape', async () => {
    next = { ok: false, status: 422, error: 'Health was locked: no step samples' };
    const res = await post('/api/health/ingest', 'ingest');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'Health was locked: no step samples' });
  });

  it('rejects bodies over 1 MB before calling the service', async () => {
    const res = await post('/api/health/ingest', 'ingest', `{"x":"${'a'.repeat(1024 * 1024)}"}`);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: 'body too large' });
    expect(calls).toHaveLength(0);
  });

  it('answers 404 when the ingest verifier/service is not configured, even without user auth', async () => {
    const res = await makeApp(false).request('/api/health/ingest', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': '', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'not found' });
  });
});

describe('health ingest auth invariants', () => {
  it.each([
    ['ingest token cannot read tasks', 'ingest'],
    ['user email token cannot ingest', 'user'],
    ['main-AUD access token cannot ingest', 'main-aud'],
  ])('%s', async (_name, token) => {
    const path = token === 'ingest' ? '/api/tasks' : '/api/health/ingest';
    const res = await post(path, token);
    expect(res.status).toBe(401);
    const json = await res.json();
    if (token === 'ingest') expect(json).toEqual({ code: 'unauthorized', message: 'sign in required', retryable: false });
    else expect(json).toEqual({ ok: false, error: 'sign in required' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['GET exact ingest', 'GET', '/api/health/ingest'],
    ['GET ingest suffix', 'GET', '/api/health/ingest/x'],
    ['POST ingest suffix', 'POST', '/api/health/ingest/x'],
  ])('%s still goes through the user middleware', async (_name, method, path) => {
    const app = makeApp();
    const bad = await app.request(path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'ingest' } });
    expect(bad.status).toBe(401);
    const good = await app.request(path, { method, headers: { 'Cf-Access-Jwt-Assertion': 'user' } });
    expect(good.status).toBe(404);
  });
});

describe('createServiceTokenVerifier', () => {
  const ISS = 'https://example-team.cloudflareaccess.com';
  const INGEST_AUD = 'health-ingest-aud';
  const MAIN_AUD = 'main-app-aud';

  let good: CryptoKey;
  let other: CryptoKey;
  let verify: ReturnType<typeof createServiceTokenVerifier>;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    good = kp.privateKey;
    other = (await generateKeyPair('RS256', { extractable: true })).privateKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
    verify = createServiceTokenVerifier({ keys: createLocalJWKSet({ keys: [jwk] }), issuer: ISS, audience: INGEST_AUD });
  });

  function token(
    opts: { key?: CryptoKey; aud?: string; iss?: string; commonName?: string | null; email?: string; exp?: string | number; iat?: number } = {},
  ) {
    const claims: Record<string, unknown> = opts.commonName === null ? {} : { common_name: opts.commonName ?? COMMON_NAME };
    if (opts.email !== undefined) claims.email = opts.email;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? ISS)
      .setAudience(opts.aud ?? INGEST_AUD)
      .setIssuedAt(opts.iat)
      .setExpirationTime(opts.exp ?? '10m')
      .sign(opts.key ?? good);
  }

  it('accepts a valid scoped token with a non-empty common_name', async () => {
    expect(await verify(await token())).toEqual({ ok: true, commonName: COMMON_NAME });
  });

  it("accepts Cloudflare's documented service-token payload (type, aud[], sub:'', 24 h session)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({ type: 'app', aud: [INGEST_AUD], exp: now + 24 * 3600, iss: ISS, common_name: COMMON_NAME, iat: now, sub: '' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .sign(good);
    expect(await verify(jwt)).toEqual({ ok: true, commonName: COMMON_NAME });
  });

  const now = () => Math.floor(Date.now() / 1000);
  it.each([
    ['missing token', 'no-token', async () => undefined],
    ['wrong audience', 'aud', async () => token({ aud: MAIN_AUD })],
    ['wrong issuer', 'iss', async () => token({ iss: 'https://other-team.cloudflareaccess.com' })],
    ['signed by another key', 'bad-signature', async () => token({ key: other })],
    ['malformed token', 'bad-signature', async () => 'not.a.jwt'],
    ['expired', 'expired', async () => token({ iat: now() - 7200, exp: now() - 3600 })],
    ['email claim present', 'email-present', async () => token({ email: EMAIL })],
    ['empty common_name', 'missing-claim', async () => token({ commonName: '' })],
    ['no common_name', 'missing-claim', async () => token({ commonName: null })],
    ['lifetime over 24 h', 'lifetime', async () => token({ exp: '30h' })],
    ['issued over 24 h ago', 'lifetime', async () => token({ iat: now() - 25 * 3600, exp: now() + 3600 })],
    ['issued in the future', 'lifetime', async () => token({ iat: now() + 3600, exp: now() + 7200 })],
  ])('rejects %s as %s', async (_name, reason, make) => {
    expect(await verify(await make())).toEqual({ ok: false, reason });
  });
});
