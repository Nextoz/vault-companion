import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
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

  it('fails without leaking the token endpoint body', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const source = createInstallationTokenSource({
      appId: '1',
      installationId: '2',
      privateKeyPem: await exportPKCS8(privateKey),
      fetch: (async () => new Response('{"message":"Bad credentials secret-ish"}', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(source()).rejects.toThrow('installation token request failed with status 401');
  });
});
