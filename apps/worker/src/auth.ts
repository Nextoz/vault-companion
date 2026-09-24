// Independent verification of the Cloudflare Access JWT (docs/security.md, ADR-0008).
// Access sits in front of the app, but the Worker never trusts that alone.
import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  /** Remote JWKS in production (`createRemoteJWKSet(<team>/cdn-cgi/access/certs)`), local set in tests. */
  readonly keys: JWTVerifyGetKey;
  readonly issuer: string;
  readonly audience: string;
  readonly allowedEmails: readonly string[];
}

export type Identity = { readonly ok: true; readonly email: string; readonly accountKey: string } | { readonly ok: false };

export function createAccessVerifier(config: AccessConfig) {
  const allowed = new Set(config.allowedEmails.map((e) => e.toLowerCase()));
  return async function verify(token: string | undefined): Promise<Identity> {
    if (!token) return { ok: false };
    try {
      const { payload } = await jwtVerify(token, config.keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!payload.sub || !allowed.has(email)) return { ok: false };
      return { ok: true, email, accountKey: await sha256Hex(payload.sub) };
    } catch {
      return { ok: false };
    }
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
