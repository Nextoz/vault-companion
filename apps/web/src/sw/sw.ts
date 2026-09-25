// Service worker. Built to /sw.js by the plugin in vite.config.ts, which injects the precache manifest.
// index.html: network-first with cached fallback. /assets/*: cache-first (content-hashed). Everything else,
// and in particular /api/*, is never intercepted.
import { isCacheableShell, strategyFor } from './policy.ts';

declare const self: ServiceWorkerGlobalScope;

const MANIFEST = JSON.parse('__VC_PRECACHE__') as { version: string; precache: string[] };
const CACHE = `vc-shell-${MANIFEST.version}`;
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(MANIFEST.precache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('vc-shell-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function shell(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (isCacheableShell(res)) await cache.put(SHELL, res.clone());
    return res;
  } catch (error) {
    const cached = await cache.match(SHELL);
    if (cached) return cached;
    throw error;
  }
}

async function asset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  // ignoreVary: a `Vary: Origin` asset response must still match the precached copy offline (P2-B finding).
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const strategy = strategyFor(new URL(request.url), request.method, request.mode, self.location.origin);
  if (strategy === 'shell') event.respondWith(shell(request));
  else if (strategy === 'asset') event.respondWith(asset(request));
});
