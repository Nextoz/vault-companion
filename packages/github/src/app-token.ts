// GitHub App installation tokens (docs/security.md#secrets): the private key stays server-side;
// installation tokens are short-lived, cached in memory until 5 minutes before expiry, never logged.
import { importPKCS8, SignJWT } from 'jose';

export interface AppTokenOptions {
  readonly appId: string;
  /** PKCS#8 PEM (convert GitHub's PKCS#1 key once with `openssl pkcs8 -topk8 -nocrypt`). */
  readonly privateKeyPem: string;
  readonly installationId: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  readonly now?: () => number;
}

export function createInstallationTokenSource(opts: AppTokenOptions): () => Promise<string> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let keyPromise: Promise<CryptoKey> | null = null;

  return async function token(): Promise<string> {
    if (cached && cached.expiresAt - 5 * 60_000 > now()) return cached.token;
    keyPromise ??= importPKCS8(opts.privateKeyPem, 'RS256');
    const iat = Math.floor(now() / 1000) - 60; // GitHub recommends back-dating for clock drift
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(opts.appId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 9 * 60)
      .sign(await keyPromise);
    const res = await f(`${opts.apiBase ?? 'https://api.github.com'}/app/installations/${opts.installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vault-companion' },
    });
    if (res.status !== 201) throw new Error(`installation token request failed with status ${res.status}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  };
}
