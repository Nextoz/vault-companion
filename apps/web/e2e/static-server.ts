// A minimal static server for a production build whose root can be swapped while it runs, so a test can
// "deploy" a new build to the same origin (a service worker is bound to its origin). /api/* is never served
// here: tests route it with MockApi on the browser context.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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

  /** `headers` are added to every response (and override the defaults below). */
  constructor(root: string, headers: Record<string, string> = {}) {
    this.root = root;
    this.#server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      this.requests.push({ path, origin: req.headers.origin ?? null });
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
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}
