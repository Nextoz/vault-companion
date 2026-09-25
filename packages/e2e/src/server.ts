// Test harness only — not a production entry. Hosts the real Worker app (`createApp`) on Node over the real command
// service and `LocalGitStore` against a disposable bare repository. Authentication is the real Access verifier with a
// locally generated key set and signed tokens; nothing is bypassed. Fault injection is limited to what a network or
// an upstream can do to the real stack: drop a response after the server finished, or make the repository vanish.
import { serve, type HttpBindings } from '@hono/node-server';
import { createCommandService } from '@vault-companion/domain';
import { LocalGitStore } from '@vault-companion/github/local-git';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../../apps/worker/src/app.ts';
import { createAccessVerifier } from '../../../apps/worker/src/auth.ts';
import type { LogRecord } from '../../../apps/worker/src/log.ts';

export const APP_ORIGIN = 'https://vc.example.invalid';
const ISSUER = 'https://e2e-team.example.invalid';
const AUDIENCE = 'e2e-audience';
export const OWNER_EMAIL = 'owner@example.invalid';

export interface HarnessServerOptions {
  readonly bare: string;
  readonly now: () => Date;
  readonly timeZone: string;
  /** Environment for the store's git processes (hermetic config). */
  readonly gitEnv: NodeJS.ProcessEnv;
}

export interface HarnessServer {
  readonly baseUrl: string;
  readonly logs: readonly LogRecord[];
  /** A freshly signed Access JWT for `email` (default: the allowed owner). */
  token(email?: string): Promise<string>;
  /** The next POST /api/commands runs to completion, then its connection is destroyed before the response is sent. */
  dropNextCommandResponse(): void;
  close(): Promise<void>;
}

export async function startServer(opts: HarnessServerOptions): Promise<HarnessServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = 'e2e-key';
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256' }] });
  const verify = createAccessVerifier({ keys, issuer: ISSUER, audience: AUDIENCE, allowedEmails: [OWNER_EMAIL] });

  // LocalGitStore copies process.env at construction; scope the hermetic git environment to that moment.
  const saved = { ...process.env };
  Object.assign(process.env, opts.gitEnv);
  const store = new LocalGitStore({ repo: opts.bare, author: { name: 'Vault Companion', email: 'vault-companion@example.invalid' } });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);

  const services = createCommandService({ store, now: opts.now, timeZone: opts.timeZone });
  const logs: LogRecord[] = [];
  const app = createApp({ verify, appOrigin: APP_ORIGIN, services, log: (r) => logs.push(r) });

  let dropArmed = false;
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, env) => {
      const response = await app.fetch(request);
      if (dropArmed && request.method === 'POST' && new URL(request.url).pathname === '/api/commands') {
        dropArmed = false;
        // The command has fully executed (and committed, if it could); the client never sees the answer.
        (env as HttpBindings).outgoing.socket?.destroy();
      }
      return response;
    },
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    async token(email = OWNER_EMAIL) {
      return new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('e2e-owner-subject')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
    },
    dropNextCommandResponse() {
      dropArmed = true;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
