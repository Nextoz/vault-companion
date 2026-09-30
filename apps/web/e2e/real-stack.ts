// Real-stack fixture (review O3): the built web app and the real Worker app on ONE origin. The browser talks to a
// StaticServer that serves `dist/` and forwards /api/* to the packages/e2e harness server (real command service over
// LocalGitStore on a disposable bare repo). The gateway plays Cloudflare Access: it adds a signed Access JWT from the
// harness's local key set to every /api request. Its only fault is holding a command response the server has already
// produced, as a slow network would. Synthetic data only.
import { rmSync } from 'node:fs';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desktop } from '../../../packages/e2e/src/desktop.ts';
import { createRemote, logWithOps, tryGit, type LoggedCommit, type RemoteFixture } from '../../../packages/e2e/src/git.ts';
import { startServer, type HarnessServer } from '../../../packages/e2e/src/server.ts';
import { StaticServer } from './static-server.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
export const TIME_ZONE = 'Europe/Copenhagen';

export interface RealStack {
  readonly origin: string;
  readonly remote: RemoteFixture;
  readonly server: HarnessServer;
  /** A desktop clone synced by the W1–W5 model (packages/e2e/src/desktop.ts). */
  readonly desktop: Desktop;
  /** Commits on the bare repo's main, oldest first, with their operation trailers. */
  commits(): LoggedCommit[];
  /** A file on the bare repo's main, byte for byte. */
  read(path: string): string;
  /** Until the returned release runs, every /api/commands answer is held after the server produced it. */
  holdCommandResponses(): () => void;
  /** Command answers held right now. */
  held(): number;
  close(): Promise<void>;
}

export async function startRealStack(seed: Readonly<Record<string, string>>): Promise<RealStack> {
  const remote = createRemote(seed);
  const steps: (() => unknown)[] = [() => rmSync(remote.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })];
  const close = async () => {
    for (const step of steps.reverse()) await step();
  };
  try {
    let upstream: URL | null = null;
    let token: Promise<string> | null = null;
    let gate: Promise<void> | null = null;
    let held = 0;

    const forward = (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          if (!upstream || !token) return res.writeHead(503).end();
          const headers = { ...req.headers, 'cf-access-jwt-assertion': await token };
          delete headers.host;
          const isCommand = req.method === 'POST' && req.url === '/api/commands';
          const up = request(upstream, { method: req.method, path: req.url, headers }, (upRes) => {
            const body: Buffer[] = [];
            upRes.on('data', (c: Buffer) => body.push(c));
            upRes.on('end', () => {
              void (async () => {
                const wait = isCommand ? gate : null;
                if (wait) {
                  held++;
                  await wait;
                  held--;
                }
                const out = { ...upRes.headers };
                delete out['transfer-encoding']; // the body is re-sent whole
                res.writeHead(upRes.statusCode ?? 502, out).end(Buffer.concat(body));
              })();
            });
          });
          up.on('error', () => res.destroy());
          up.end(Buffer.concat(chunks));
        })();
      });
    };

    const gateway = new StaticServer(DIST, {}, forward);
    await gateway.listen(0);
    steps.push(() => gateway.close());
    const origin = `http://localhost:${(gateway.address() as AddressInfo).port}`;

    const server = await startServer({ bare: remote.bare, gitEnv: remote.env, now: () => new Date(), timeZone: TIME_ZONE, appOrigin: origin });
    steps.push(() => server.close());
    upstream = new URL(server.baseUrl);
    token = server.token();

    const desktop = Desktop.clone(remote.env, remote.bare, join(remote.root, 'desktop'));
    return {
      origin,
      remote,
      server,
      desktop,
      commits: () => logWithOps(remote.env, remote.bare),
      read: (path) => tryGit(remote.env, remote.bare, 'show', `main:${path}`).stdout,
      holdCommandResponses() {
        let release!: () => void;
        const current = new Promise<void>((resolve) => (release = resolve));
        gate = current;
        return () => {
          if (gate === current) gate = null;
          release();
        };
      },
      held: () => held,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

/** Today's date where the owner lives, as the server stamps it. */
export const todayIn = (timeZone = TIME_ZONE): string => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
