import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { createApp, type Services } from './app.ts';
import { createProductionApp, productionLeaderboard, runScheduled, type Env } from './index.ts';

const origin = 'https://vc.example.com';
const env: Env = { AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud-test', ALLOWED_EMAILS: 'owner@example.com', APP_ORIGIN: origin, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'unused', GITHUB_INSTALLATION_ID: '2', VAULT_OWNER: 'synthetic', VAULT_REPO: 'synthetic' };
const services: Services = { readTasks: async () => ({ code: 'upstream-unavailable', message: 'test', retryable: true }), execute: async () => ({ code: 'invalid', message: 'test', retryable: false }) };
const envelope = { intelligence_index_version: 4.3, data: [{ slug: 'synthetic', name: 'Synthetic model', evaluations: { artificial_analysis_intelligence_index: 42 } }], pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false } };
function kvStore() {
  let data: unknown = null;
  return { get: vi.fn(async () => structuredClone(data)), put: vi.fn(async (_key: string, value: string) => { data = JSON.parse(value); }) };
}
describe('leaderboard route', () => {
  it('requires authentication before reading storage and returns no-store', async () => {
    const readLeaderboard = vi.fn(async () => ({ status: 'unavailable' as const, now: new Date(0).toISOString(), reason: 'no-data' as const, note: 'No data' }));
    const app = createApp({ services: { ...services, readLeaderboard }, appOrigin: origin, log: () => {}, verify: async token => token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: 'a'.repeat(64) } : { ok: false } });
    expect((await app.request('/api/leaderboard')).status).toBe(401); expect(readLeaderboard).not.toHaveBeenCalled();
    const response = await app.request('/api/leaderboard', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(readLeaderboard).toHaveBeenCalledTimes(1);
  });
});
describe('real production and scheduled wiring', () => {
  let keys: JWTVerifyGetKey, token: string;
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'test', alg: 'RS256' }] });
    token = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_AUD).setSubject('test').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
  });
  it('composes the route, tolerates missing binding, and keeps session working', async () => {
    const provider = vi.fn(), app = createProductionApp(env, keys, provider);
    const headers = { 'Cf-Access-Jwt-Assertion': token };
    const response = await app.request('/api/leaderboard', { headers });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'unavailable', reason: 'storage-unavailable' });
    expect((await app.request('/api/session', { headers })).status).toBe(200); expect(provider).not.toHaveBeenCalled();
  });
  it('serves a durable snapshot across production instances without provider traffic', async () => {
    const kv = kvStore(); const configured = { ...env, LEADERBOARD_KV: kv, AA_API_KEY: 'synthetic' };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope)));
    await productionLeaderboard(configured, fetcher).refresh(); expect(fetcher).toHaveBeenCalledTimes(1); fetcher.mockClear();
    const response = await createProductionApp(configured, keys, fetcher).request('/api/leaderboard', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(await response.json()).toMatchObject({ status: 'ok', rankings: { overall: ['synthetic'] } }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('reuses only the daily cron, single-flights by persisted day, and isolates provider failure', async () => {
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const kv = kvStore(), configured = { ...env, LEADERBOARD_KV: kv, AA_API_KEY: 'synthetic' };
      const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope)));
      await runScheduled('30 6 * * *', configured, fetcher); expect(fetcher).not.toHaveBeenCalled();
      await runScheduled('30 4 * * *', configured, fetcher); await runScheduled('30 4 * * *', configured, fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(kv.put).toHaveBeenCalledTimes(1);
      // No Gemini key is present; its existing unavailable path must still execute.
      expect(printed.mock.calls.some(c => String(c[0]).includes('gemini-key-missing'))).toBe(true);
      const failed = vi.fn(async () => { throw new Error('synthetic private error'); });
      await expect(runScheduled('30 4 * * *', { ...configured, LEADERBOARD_KV: kvStore() }, failed)).resolves.toBeUndefined();
      expect(JSON.stringify(printed.mock.calls)).not.toContain('synthetic private error');
    } finally { printed.mockRestore(); }
  });
  it('counts KV operations as well as provider requests in the shared cron budget', async () => {
    const count = vi.fn(), fetcher = vi.fn(async () => new Response(JSON.stringify(envelope)));
    await productionLeaderboard({ AA_API_KEY: 'synthetic', LEADERBOARD_KV: kvStore() }, fetcher, Date.now, count).refresh();
    expect(count).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
