import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAccessVerifier } from './auth.ts';

const ISS = 'https://example-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const EMAIL = 'owner@example.com';

let good: CryptoKey;
let other: CryptoKey;
let verify: ReturnType<typeof createAccessVerifier>;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true });
  const kp2 = await generateKeyPair('RS256', { extractable: true });
  good = kp.privateKey;
  other = kp2.privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  verify = createAccessVerifier({ keys: createLocalJWKSet({ keys: [jwk] }), issuer: ISS, audience: AUD, allowedEmails: [EMAIL] });
});

function token(opts: { key?: CryptoKey; iss?: string; aud?: string; email?: string; exp?: string | number; sub?: string; alg?: string } = {}) {
  return new SignJWT({ email: opts.email ?? EMAIL })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setSubject(opts.sub ?? 'user-sub-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? good);
}

describe('createAccessVerifier', () => {
  it('accepts a valid token and derives a stable accountKey from sub', async () => {
    const a = await verify(await token());
    const b = await verify(await token());
    expect(a).toMatchObject({ ok: true, email: EMAIL });
    expect(a.ok && a.accountKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.ok && b.ok && a.accountKey === b.accountKey).toBe(true);
  });
  it('different sub ⇒ different accountKey (queue binding, T14)', async () => {
    const a = await verify(await token());
    const b = await verify(await token({ sub: 'other-sub' }));
    expect(a.ok && b.ok && a.accountKey !== b.accountKey).toBe(true);
  });
  it.each([
    ['missing token', async () => undefined],
    ['garbage', async () => 'not.a.jwt'],
    ['signed by another key', async () => token({ key: other })],
    ['wrong audience', async () => token({ aud: 'other-app' })],
    ['wrong issuer', async () => token({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', async () => token({ exp: Math.floor(Date.now() / 1000) - 600 })],
    // Review A6: claims must be present, lifetime bounded, nbf honoured.
    ['no exp claim', async () => new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setSubject('s').setIssuedAt().sign(good)],
    ['no iat claim', async () => new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setSubject('s').setExpirationTime('10m').sign(good)],
    ['lifetime over 24 h', async () => token({ exp: '30h' })],
    ['issued in the future (iat)', async () => new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setSubject('s').setIssuedAt(Math.floor(Date.now() / 1000) + 3600).setExpirationTime(Math.floor(Date.now() / 1000) + 7200).sign(good)],
    ['not yet valid (nbf)', async () => new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setSubject('s').setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000) + 3600).setExpirationTime('2h').sign(good)],
    ['no sub claim', async () => new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('10m').sign(good)],
    ['email not allowlisted', async () => token({ email: 'someone@example.com' })],
  ])('rejects %s', async (_name, make) => {
    expect(await verify(await make())).toEqual({ ok: false });
  });
});
