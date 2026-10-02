// Independent verification of the Cloudflare Access JWT (docs/security.md, ADR-0008).
// Access sits in front of the app, but the Worker never trusts that alone.
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  /** Remote JWKS in production (`createRemoteJWKSet(<team>/cdn-cgi/access/certs)`), local set in tests. */
  readonly keys: JWTVerifyGetKey;
  readonly issuer: string;
  readonly audience: string;
  readonly allowedEmails: readonly string[];
}

/** Access sessions are configured at ≤ 24 h (docs/security.md); anything longer is rejected. */
const MAX_TOKEN_LIFETIME_S = 24 * 60 * 60;
const CLOCK_TOLERANCE_S = 5 * 60;

export type Identity = { readonly ok: true; readonly email: string; readonly accountKey: string } | { readonly ok: false };

/** A scoped service credential (health ingest). It has no account key and must not carry an email. */
export type ServiceTokenIdentity =
  | { readonly ok: true; readonly commonName: string }
  | { readonly ok: false; readonly reason: ServiceTokenRefusal };

export function createAccessVerifier(config: AccessConfig) {
  const allowed = new Set(config.allowedEmails.map((e) => e.toLowerCase()));
  return async function verify(token: string | undefined): Promise<Identity> {
    if (!token) return { ok: false };
    try {
      const { payload } = await jwtVerify(token, config.keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        // Review A6: expiry must exist (a token without `exp` would otherwise be valid forever), lifetime bounded.
        requiredClaims: ['exp', 'iat', 'sub'],
        maxTokenAge: MAX_TOKEN_LIFETIME_S,
        clockTolerance: CLOCK_TOLERANCE_S,
      });
      const { exp, iat } = payload as { exp: number; iat: number };
      if (exp - iat > MAX_TOKEN_LIFETIME_S) return { ok: false };
      if (iat > Date.now() / 1000 + CLOCK_TOLERANCE_S) return { ok: false };
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!payload.sub || !allowed.has(email)) return { ok: false };
      return { ok: true, email, accountKey: await sha256Hex(payload.sub) };
    } catch {
      return { ok: false };
    }
  };
}

/**
 * Why a service token was refused. Logged (and only this code — never the token or its claims) as the ingest
 * route's `errorCode`, so a live 401 can be diagnosed from `wrangler tail`.
 */
export type ServiceTokenRefusal =
  | 'no-token'
  | 'bad-signature'
  | 'iss'
  | 'aud'
  | 'expired'
  | 'missing-claim'
  | 'email-present'
  | 'lifetime'
  | 'other';

/** Same lifetime/clock rules as Access, but for the scoped health-ingest audience and a non-empty common_name. */
export function createServiceTokenVerifier(config: { readonly keys: JWTVerifyGetKey; readonly issuer: string; readonly audience: string }) {
  return async function verify(token: string | undefined): Promise<ServiceTokenIdentity> {
    if (!token) return { ok: false, reason: 'no-token' };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, config.keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'common_name'],
        maxTokenAge: MAX_TOKEN_LIFETIME_S,
        clockTolerance: CLOCK_TOLERANCE_S,
      }));
    } catch (e) {
      return { ok: false, reason: refusalOf(e) };
    }
    const { exp, iat } = payload as { exp: number; iat: number };
    if (exp - iat > MAX_TOKEN_LIFETIME_S) return { ok: false, reason: 'lifetime' };
    if (iat > Date.now() / 1000 + CLOCK_TOLERANCE_S) return { ok: false, reason: 'lifetime' };
    if (typeof payload.common_name !== 'string' || payload.common_name.trim() === '') return { ok: false, reason: 'missing-claim' };
    if ('email' in payload) return { ok: false, reason: 'email-present' };
    return { ok: true, commonName: payload.common_name };
  };
}

/** Matches jose's stable `code` strings rather than `instanceof`, which breaks if jose is ever bundled twice. */
function refusalOf(e: unknown): ServiceTokenRefusal {
  const { code, claim, reason } = (e ?? {}) as { code?: string; claim?: string; reason?: string };
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      // jose reports `maxTokenAge` (iat too old) as expired on the `iat` claim: that is our lifetime rule.
      return claim === 'iat' ? 'lifetime' : 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (reason === 'missing') return 'missing-claim';
      if (claim === 'iss') return 'iss';
      if (claim === 'aud') return 'aud';
      if (claim === 'iat' || claim === 'nbf') return 'lifetime';
      return 'other';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'bad-signature';
    default:
      return 'other';
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
