import { HEALTH_VITALS_DAILY_CSV, ringSlotsPath } from '@vault-companion/contracts';
import { RING_METRICS, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { createProductionApp, type Env } from './index.ts';
import { createRingIngestService } from './ring-ingest.ts';

const PATH = '/api/health/ring/ingest', sentinel = 980 + 7;
const now = () => new Date('2026-11-02T12:00:00+01:00');
// Random ids, timings and hex hashes can contain the sentinel's digits by chance (a flaky CI failure on main); every
// other log field is checked.
const logged = (calls: unknown[][]) => JSON.stringify(calls.map(([record]) => ({ ...(record as object), requestId: '', durationMs: 0, operationId: '', pathHash: '', commitSha: '' })));
const payload = (start = '2026-11-01T12:00:00+01:00') => JSON.stringify({ schema: 'ring-slots/1', device: 'synthetic', generatedAt: now().toISOString(), slots: [{ start, ...Object.fromEntries(RING_METRICS.map((m) => [m.key, null])), hr: sentinel }] });

it.each([400, 401, 404, 409, 413, 422, 503, 200])('returns the ring response contract for %i without logging values', async (status) => {
  const store = await InMemoryStore.create(status === 409 ? { [ringSlotsPath('2026-11')]: 'bad header\n' } : {});
  if (status === 503) store.writeFaults.push('unavailable');
  const log = vi.fn(), ingest = vi.fn(createRingIngestService({ store, now }).ingestRing);
  const app = createApp({ verify: async () => ({ ok: false }), ...(status === 404 ? {} : { verifyIngest: async () => status === 401 ? { ok: false as const, reason: 'aud' as const } : { ok: true as const, commonName: 'synthetic' } }), appOrigin: 'https://vc.example.com', log,
    services: { readTasks: async () => ({ code: 'upstream-unavailable', message: 'x', retryable: true }), execute: async () => ({ code: 'upstream-unavailable', message: 'x', retryable: true }), ingestRing: ingest } });
  const body = status === 400 ? '{' : status === 422 ? payload('2026-11-01T12:07:00+01:00') : status === 413 ? 'ø'.repeat(600000) : payload();
  const res = await app.request(PATH, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': String(sentinel) }, body });
  expect(res.status).toBe(status);
  const json = await res.json();
  if (status === 200) { expect(json).toEqual({ ok: true, slots: 1, months: ['2026-11'], days: ['2026-11-01'] }); expect(json).not.toHaveProperty('error'); }
  else { expect(json).toEqual({ ok: false, error: expect.any(String) }); expect(JSON.stringify(json)).not.toContain(String(sentinel)); }
  if ([401, 404, 413].includes(status)) expect(ingest).not.toHaveBeenCalled();
  expect(logged(log.mock.calls)).not.toContain(String(sentinel));
  expect(store.commitMessages().join()).not.toContain(String(sentinel));
  if (status === 200) expect(store.text(HEALTH_VITALS_DAILY_CSV)).toContain(String(sentinel));
});
it('returns a private 503 for an unexpected service exception', async () => {
  const log = vi.fn(), app = createApp({ verify: async () => ({ ok: false }), verifyIngest: async () => ({ ok: true, commonName: 'synthetic' }), appOrigin: 'https://vc.example.com', log,
    services: { readTasks: async () => { throw new Error(); }, execute: async () => { throw new Error(); }, ingestRing: async () => { throw new StoreUnavailable(String(sentinel)); } } });
  const res = await app.request(PATH, { method: 'POST', body: payload() });
  expect(res.status).toBe(503); expect(await res.json()).toEqual({ ok: false, error: 'ring ingest unavailable; resend' });
  expect(JSON.stringify(log.mock.calls)).not.toContain(String(sentinel));
});
it.each([true, false])('production wiring enables only the scoped verifier (configured=%s)', async (enabled) => {
  const kp = await generateKeyPair('RS256', { extractable: true }), team = 'https://team.cloudflareaccess.com';
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k', alg: 'RS256' }] });
  const env: Env = { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: 'main', ALLOWED_EMAILS: 'owner@example.com', APP_ORIGIN: 'https://vc.example.com', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'unused', GITHUB_INSTALLATION_ID: '2', VAULT_OWNER: 'o', VAULT_REPO: 'r', ...(enabled ? { HEALTH_INGEST_AUD: 'ingest' } : {}) };
  const token = await new SignJWT({ common_name: 'synthetic' }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setIssuer(team).setAudience('ingest').setIssuedAt().setExpirationTime('1h').sign(kp.privateKey);
  const app = createProductionApp(env, keys), res = await app.request(PATH, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token }, body: '{}' });
  expect(res.status).toBe(enabled ? 400 : 404); expect(await res.json()).toEqual({ ok: false, error: expect.any(String) });
  for (const [method, path] of [['GET', PATH], ['POST', `${PATH}/x`], ['GET', '/api/health/ring']]) expect((await app.request(path!, { method: method!, headers: { 'Cf-Access-Jwt-Assertion': token } })).status).toBe(401);
});
