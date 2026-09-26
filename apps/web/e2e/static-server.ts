// A minimal static server for a production build whose root can be swapped while it runs, so a test can
// "deploy" a new build to the same origin (a service worker is bound to its origin). /api/* is served only by an
// `api` handler (the real-stack gateway); otherwise tests route it with MockApi on the browser context.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export class StaticServer {
  root: string;
  /** Every request, with its `Origin` header (null when absent). */
  readonly requests: { path: string; origin: string | null }[] = [];
  readonly #server: Server;

  /** `headers` are added to every response (and override the defaults below); `api` answers every /api/* request. */
  constructor(root: string, headers: Record<string, string> = {}, api?: (req: IncomingMessage, res: ServerResponse) => void) {
    this.root = root;
    this.#server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      this.requests.push({ path, origin: req.headers.origin ?? null });
      if (api && path.startsWith('/api/')) return api(req, res);
      const file = normalize(join(this.root, path === '/' ? 'index.html' : path));
      if (!file.startsWith(normalize(this.root))) return res.writeHead(403).end();
      readFile(file).then(
        (body) => {
          // Revalidate every time: what a load sees is decided by the service worker, not the HTTP cache.
          res.writeHead(200, {
            'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
            ...headers,
          });
          res.end(body);
        },
        () => res.writeHead(404).end(),
      );
    });
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, 'localhost', () => resolve());
    });
  }

  address(): ReturnType<Server['address']> {
    return this.#server.address();
  }

  close(): Promise<void> {
    // Stop accepting first, then drop keep-alive connections of a still-open page, which would otherwise hold the
    // close until they time out (Node: close() before closeAllConnections()).
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections();
    return closed;
  }
}
