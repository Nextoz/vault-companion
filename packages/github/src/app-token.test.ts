import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { StoreUnavailable } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import { createInstallationTokenSource } from './app-token.ts';

describe('createInstallationTokenSource', () => {
  it('signs an RS256 app JWT, caches the token, and refreshes 5 minutes before expiry', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    let t = Date.parse('2026-09-24T12:00:00Z');
    let issued = 0;
    const source = createInstallationTokenSource({
      appId: '12345',
      installationId: '678',
      privateKeyPem: pem,
      now: () => t,
      fetch: (async (url: string, init: RequestInit) => {
        expect(url).toBe('https://api.github.com/app/installations/678/access_tokens');
        const jwt = (init.headers as Record<string, string>).Authorization!.replace('Bearer ', '');
        const { payload } = await jwtVerify(jwt, publicKey, { currentDate: new Date(t) });
        expect(payload.iss).toBe('12345');
        issued++;
        return new Response(JSON.stringify({ token: `ghs_${issued}`, expires_at: new Date(t + 60 * 60_000).toISOString() }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    expect(await source()).toBe('ghs_1');
    t += 50 * 60_000;
    expect(await source()).toBe('ghs_1'); // still > 5 min left
    t += 6 * 60_000;
    expect(await source()).toBe('ghs_2'); // within 5 min of expiry
  });

  it('shares one token POST between two concurrent cold callers', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    let posts = 0;
    const source = createInstallationTokenSource({
      appId: '1',
      installationId: '2',
      privateKeyPem: await exportPKCS8(privateKey),
      fetch: (async (_url: unknown, init: RequestInit) => {
        expect(init.method).toBe('POST');
        posts++;
        return new Response(JSON.stringify({ token: `ghs_${posts}`, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }), { status: 201 });
      }) as typeof fetch,
    });
    expect(await Promise.all([source(), source()])).toEqual(['ghs_1', 'ghs_1']);
    expect(posts).toBe(1);
  });

  it.each(['http', 'network', 'json'] as const)('maps %s failure to StoreUnavailable without leaking details and retries', async (failure) => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    let posts = 0;
    const source = createInstallationTokenSource({
      appId: '1',
      installationId: '2',
      privateKeyPem: await exportPKCS8(privateKey),
      fetch: (async () => {
        posts++;
        if (posts === 1) {
          if (failure === 'network') throw new Error('secret-ish network details');
          return new Response('secret-ish response body', { status: failure === 'http' ? 401 : 201 });
        }
        return new Response(JSON.stringify({ token: 'ghs_retry', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }), { status: 201 });
      }) as typeof fetch,
    });
    const results = await Promise.allSettled([source(), source()]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('expected token failure');
      expect(result.reason).toBeInstanceOf(StoreUnavailable);
      expect(result.reason.message).not.toContain('secret-ish');
      expect(result.reason.cause).toBeUndefined();
    }
    expect(posts).toBe(1);
    expect(await source()).toBe('ghs_retry');
    expect(posts).toBe(2);
  });
});
