import { describe, expect, it } from 'vitest';
import worker, { configProblems, type Env } from './index.ts';

const full: Env = {
  AUTH_MODE: 'access',
  ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  ACCESS_AUD: 'aud',
  ALLOWED_EMAILS: 'owner@example.com',
  APP_ORIGIN: 'https://vc.example.com',
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'pem',
  GITHUB_INSTALLATION_ID: '2',
  VAULT_OWNER: 'o',
  VAULT_REPO: 'r',
};

describe('production configuration guard', () => {
  it('accepts a complete Access configuration', () => {
    expect(configProblems(full)).toEqual([]);
  });
  it.each([
    ['dev auth', { AUTH_MODE: 'dev' }],
    ['missing auth mode', { AUTH_MODE: '' }],
    ['missing audience', { ACCESS_AUD: '' }],
    ['missing private key', { GITHUB_APP_PRIVATE_KEY: '' }],
    ['http origin', { APP_ORIGIN: 'http://vc.example.com' }],
  ])('rejects %s', (_n, over) => {
    expect(configProblems({ ...full, ...over }).length).toBeGreaterThan(0);
  });
  it('a misconfigured worker answers 503 without details and never reaches the API', async () => {
    const res = await worker.fetch(new Request('https://vc.example.com/api/session'), { ...full, AUTH_MODE: 'dev' });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Service not configured');
  });
  it('a configured worker requires the Access JWT (no token ⇒ 401)', async () => {
    const res = await worker.fetch(new Request('https://vc.example.com/api/session'), full);
    expect(res.status).toBe(401);
  });
});
