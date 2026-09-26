// Regression (first deploy, 2026-09-26): Cloudflare Workers reject the global fetch when it is called with another
// object as `this` ("Illegal invocation"); Node does not, so only a Workers-like fetch catches it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstallationTokenSource } from './app-token.ts';
import { GitHubContentsStore } from './contents-store.ts';

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; vi.restoreAllMocks(); });

function workersLikeFetch(respond: (url: string) => Response): typeof fetch {
  return function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return Promise.resolve(respond(String(input)));
  } as typeof fetch;
}

describe('the default fetch is called unbound-safe (Workers)', () => {
  it('GitHubContentsStore without an injected fetch reaches the network', async () => {
    globalThis.fetch = workersLikeFetch(() => new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } }), { status: 200 }));
    const store = new GitHubContentsStore({ owner: 'o', repo: 'r', token: async () => 't' });
    await expect(store.head()).resolves.toMatchObject({ commitSha: 'a'.repeat(40) });
  });

  it('the installation token source without an injected fetch reaches the network', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    globalThis.fetch = workersLikeFetch(() => new Response(JSON.stringify({ token: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 }));
    await expect(createInstallationTokenSource({ appId: '1', privateKeyPem: pem, installationId: '2' })()).resolves.toBe('x');
  });
});
