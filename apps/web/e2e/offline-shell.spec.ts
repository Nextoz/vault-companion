// Service-worker offline shell against the production build (P2-B). Runs only in the Chromium project, with
// service workers allowed: Playwright routes service-worker network traffic and emulates offline for it in
// Chromium only. The API is routed on the context, so requests a service worker makes are seen too.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { build, type Plugin } from 'vite';
import { MockApi, taskView } from './mock-api.ts';
import { StaticServer } from './static-server.ts';

let api: MockApi;

test.beforeEach(async ({ context }) => {
  api = new MockApi();
  api.open = [taskView(10, 'Water the plants'), taskView(11, 'Call the bike shop')];
  await api.install(context);
});

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const offlineBanner = (page: Page) => page.getByRole('status').filter({ hasText: 'Offline.' });

/** The first load is controlled once the worker has installed (precache filled) and claimed the page. */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function setNetwork(context: BrowserContext, up: boolean): Promise<void> {
  api.network = up ? 'up' : 'down';
  await context.setOffline(!up);
}

const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

/** Every request URL path held in any Cache Storage cache of this origin. */
const cachedPaths = (page: Page) =>
  page.evaluate(async () => {
    const paths: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) paths.push(new URL(req.url).pathname);
    }
    return paths;
  });

/** The `pending` store of the app's IndexedDB database, read directly. */
const pendingRecords = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ operationId: string; type: string }[]>((resolve, reject) => {
        const open = indexedDB.open('vault-companion');
        open.onerror = () => reject(open.error ?? new Error('open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const all = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          all.onerror = () => reject(all.error ?? new Error('read failed'));
          all.onsuccess = () => {
            db.close();
            resolve((all.result as { operationId: string; type: string }[]).map(({ operationId, type }) => ({ operationId, type })));
          };
        };
      }),
  );

const WEB = fileURLToPath(new URL('..', import.meta.url));

/** A real production build of the app, plus one statement that tags it and so changes the entry asset hash. */
async function buildTagged(outDir: string, tag: string): Promise<void> {
  const tagEntry: Plugin = {
    name: 'e2e-build-tag',
    renderChunk(code, chunk) {
      if (!chunk.isEntry || !chunk.fileName.startsWith('assets/')) return null;
      return `${code}\n;globalThis.__vcBuild=${JSON.stringify(tag)};\n`;
    },
  };
  await build({
    root: WEB,
    configFile: join(WEB, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [tagEntry],
  });
}

test('after one online visit the shell loads offline and shows the offline state', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await controlled(page);

  await setNetwork(context, false);
  await page.reload(); // without the worker's cached shell this navigation fails with a browser error page
  await expect(page.getByRole('button', { name: 'Capture' })).toBeVisible();
  await expect(offlineBanner(page)).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});

test('a completion made offline stays queued in IndexedDB through an offline reload, then is sent once', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await controlled(page);

  await setNetwork(context, false);
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  const action = region(page, 'Actions on this device').getByTestId('action');
  await expect(action).toContainText('Water the plants');
  // The offline attempt has settled (a reload during it would leave its lease to expire first, by design: A3).
  await expect(action).toContainText('On this device');

  await page.reload(); // served by the service worker; the queue comes back from IndexedDB
  await expect(offlineBanner(page)).toBeVisible();
  await expect(action).toContainText('Water the plants');
  const queued = await pendingRecords(page);
  expect(queued.map((r) => r.type)).toEqual(['CompleteTask']);
  expect(api.bodies).toHaveLength(0);

  await setNetwork(context, true); // fires `online`
  await expect(action).toContainText('Saved to GitHub');
  expect(api.applied.map((c) => [c.type, c.operationId])).toEqual([['CompleteTask', queued[0]?.operationId]]);
  await expect.poll(() => pendingRecords(page)).toEqual([]);

  // Another wake-up (session + queue kick + read) sends nothing more.
  const read = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/tasks');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await read;
  expect(api.bodies).toHaveLength(1);
});

test('/api/* is never answered from the service-worker cache', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await controlled(page);

  const fetchTasks = () =>
    page.evaluate(async () => {
      try {
        const res = await fetch('/api/tasks');
        return { status: res.status, body: await res.text() };
      } catch (error) {
        return { error: String(error) };
      }
    });
  expect(await fetchTasks()).toMatchObject({ status: 200 });
  const paths = await cachedPaths(page);
  expect(paths).toContain('/'); // the shell is cached ...
  expect(paths.filter((p) => p === '/api' || p.startsWith('/api/'))).toEqual([]); // ... no API response is

  await setNetwork(context, false);
  const offline = await fetchTasks();
  expect(offline).toHaveProperty('error');
  expect(offline).not.toHaveProperty('body');

  // The app's own reads fail too: an offline reload shows no task list, only the offline state.
  await page.reload();
  await expect(offlineBanner(page)).toBeVisible();
  await expect(page.getByText('Water the plants')).toHaveCount(0);
});

test.describe('a new build', () => {
  let dirs: { a: string; b: string };
  let server: StaticServer;
  let origin: string;

  /** The cache name the built sw.js will use (`vc-shell-<version>`, version injected by vite.config.ts). */
  async function cacheOf(dir: string): Promise<string> {
    const sw = await readFile(join(dir, 'sw.js'), 'utf8');
    const version = /version\\*"\s*:\s*\\*"([0-9a-f]{16})/.exec(sw)?.[1];
    if (!version) throw new Error('no precache version in sw.js');
    return `vc-shell-${version}`;
  }

  const buildOf = (page: Page) => page.evaluate(() => (globalThis as { __vcBuild?: string }).__vcBuild);

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const root = await mkdtemp(join(tmpdir(), 'vc-sw-e2e-'));
    dirs = { a: join(root, 'a'), b: join(root, 'b') };
    await buildTagged(dirs.a, 'a');
    await buildTagged(dirs.b, 'b');
    const entries = await Promise.all([dirs.a, dirs.b].map(async (d) => (await readdir(join(d, 'assets'))).sort().join()));
    if (entries[0] === entries[1]) throw new Error('the two builds have identical asset names');
    server = new StaticServer(dirs.a);
    await server.listen(0);
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await server?.close();
    if (dirs) await rm(join(dirs.a, '..'), { recursive: true, force: true });
  });

  test('activates on the next load, and the old shell is not served again', async ({ page, context }) => {
    const [cacheA, cacheB] = [await cacheOf(dirs.a), await cacheOf(dirs.b)];
    expect(cacheA).not.toBe(cacheB);

    server.root = dirs.a;
    await page.goto(`${origin}/`);
    await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
    await controlled(page);
    expect(await buildOf(page)).toBe('a');
    expect(await cacheNames(page)).toEqual([cacheA]);

    // Deploy build B to the same origin. The very next load runs it (the shell is network-first) ...
    server.root = dirs.b;
    await page.reload();
    await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
    expect(await buildOf(page)).toBe('b');
    // ... and the new worker takes over without waiting for every tab to close, dropping the old cache.
    await expect.poll(() => cacheNames(page), { timeout: 15_000 }).toEqual([cacheB]);
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');

    // Offline, the shell that loads is the new one, with all of its assets.
    await setNetwork(context, false);
    await page.reload();
    await expect(offlineBanner(page)).toBeVisible();
    expect(await buildOf(page)).toBe('b');
  });
});

test.describe('a host that sends Vary: Origin', () => {
  let dir: string;
  let server: StaticServer;
  let origin: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    // Its own build of the current source, not whatever dist/ holds.
    dir = await mkdtemp(join(tmpdir(), 'vc-sw-vary-'));
    await buildTagged(dir, 'vary');
    // no-store: nothing but the worker's cache can answer an offline request.
    server = new StaticServer(dir, { Vary: 'Origin', 'Cache-Control': 'no-store' });
    await server.listen(0);
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a precached asset requested with an Origin header is still served offline', async ({ page, context }) => {
    await page.goto(`${origin}/`);
    await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
    await controlled(page);

    // The worker precached every asset with requests that carry no Origin header.
    const precached = (await cachedPaths(page)).filter((p) => p.startsWith('/assets/'));
    expect(precached.length).toBeGreaterThan(0);
    for (const path of precached) {
      expect(server.requests.filter((r) => r.path === path).map((r) => r.origin), path).toContain(null);
    }
    const vary = await page.evaluate((paths) => Promise.all(paths.map(async (p) => (await caches.match(p))?.headers.get('Vary'))), precached);
    expect(vary).toEqual(precached.map(() => 'Origin'));

    await setNetwork(context, false);
    const offline = await page.evaluate(async (paths) => {
      const out: Record<string, { plain: string; withOrigin: string }> = {};
      for (const path of paths) {
        // A same-origin fetch() sends no Origin: the same cache key as the precache request.
        const plain = await fetch(path).then((r) => `status ${r.status}`, () => 'network error');
        // A crossorigin element always sends Origin, so under `Vary: Origin` it is a different cache key.
        const withOrigin = await new Promise<string>((resolve) => {
          const link = document.createElement('link');
          link.rel = 'preload';
          link.as = path.endsWith('.css') ? 'style' : 'script';
          link.crossOrigin = 'anonymous';
          link.href = path;
          link.onload = () => resolve('loaded');
          link.onerror = () => resolve('network error');
          document.head.append(link);
        });
        out[path] = { plain, withOrigin };
      }
      return out;
    }, precached);
    expect(offline).toEqual(Object.fromEntries(precached.map((p) => [p, { plain: 'status 200', withOrigin: 'loaded' }])));
  });
});
