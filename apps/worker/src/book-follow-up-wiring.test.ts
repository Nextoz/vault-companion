import { createBooksService } from '@vault-companion/domain';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { BOOK_FOLLOW_UP_SYSTEM } from './book-follow-up.ts';
import { createProductionApp, type Env } from './index.ts';

vi.mock('@vault-companion/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vault-companion/domain')>();
  return { ...actual, createBooksService: vi.fn(actual.createBooksService) };
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])('production routes use SCALEWAY_API_KEY when configured=%s', async (configured) => {
  const printed: unknown[][] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args); });
  const reflection = 'SENTINEL-SAVED synthetic reflection';
  const title = 'SENTINEL-TITLE';
  const readBooks = vi.fn<ReturnType<typeof createBooksService>['readBooks']>().mockResolvedValue({
    status: 'ok', revision: '1'.repeat(40), books: [{ title, author: '', status: 'reading', totalPages: 100, currentPage: 0, lastRead: null, reflections: [{ date: '2026-10-02', text: reflection }, { date: '2026-10-02', text: 'SENTINEL-OTHER' }] }],
  });
  vi.mocked(createBooksService).mockReturnValueOnce({ readBooks });
  const env: Env = {
    AUTH_MODE: 'access', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud',
    ALLOWED_EMAILS: 'owner@example.com', APP_ORIGIN: 'https://vc.example.com',
    GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'synthetic-pem', GITHUB_INSTALLATION_ID: '2', VAULT_OWNER: 'o', VAULT_REPO: 'r',
    ...(configured ? { SCALEWAY_API_KEY: 'SENTINEL-KEY' } : {}),
  };
  const pair = await generateKeyPair('RS256');
  const jwk = await exportJWK(pair.publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
  const token = await new SignJWT({ email: 'owner@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(env.ACCESS_TEAM_DOMAIN).setAudience(env.ACCESS_AUD).setSubject('owner').setIssuedAt().setExpirationTime('1h').sign(pair.privateKey);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'What changed?' } }] }), { status: 200 }));
  const app = createProductionApp(env, keys, fetch);
  const session = await app.request('/api/session', { headers: { 'Cf-Access-Jwt-Assertion': token } });
  const { accountKey } = await session.json() as { accountKey: string };
  const response = await app.request('/api/books/follow-up', {
    method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': token, Origin: env.APP_ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': accountKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, date: '2026-10-02', ordinal: 1 }),
  });
  if (configured) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ question: 'What changed?' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.scaleway.ai/v1/chat/completions');
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer SENTINEL-KEY');
    const body = JSON.parse(init!.body as string) as unknown;
    expect(body).toMatchObject({ model: 'glm-5.2', messages: [{ role: 'system', content: BOOK_FOLLOW_UP_SYSTEM }, { role: 'user', content: reflection }] });
    expect(body).not.toHaveProperty('response_format');
    expect(JSON.stringify(body)).not.toContain(title);
    expect(JSON.stringify(body)).not.toContain('SENTINEL-OTHER');
  } else {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'follow-up-unavailable' });
    expect(fetch).not.toHaveBeenCalled();
    expect(readBooks).not.toHaveBeenCalled();
  }
  for (const sentinel of [title, reflection, 'What changed?', 'SENTINEL-KEY']) expect(JSON.stringify(printed)).not.toContain(sentinel);
});
