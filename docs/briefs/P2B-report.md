# P2-B report — Service-worker offline shell e2e

Branch `agent/offline-shell-e2e`. Status: **tests written and verified; they expose a real SW bug (left unfixed,
per brief), so the new suite is intermittently red on `vite preview` until it is fixed.**

## What was added

| File | Change |
| --- | --- |
| `apps/web/e2e/offline-shell.spec.ts` | 4 tests, one per brief objective (below). |
| `apps/web/e2e/static-server.ts` | Tiny static server with a swappable root, so a second build can be "deployed" to the same origin. |
| `apps/web/e2e/mock-api.ts` | `install()` accepts a `BrowserContext` (only context routes see service-worker requests); `network: 'up' \| 'down'` fails every API request as a network error without recording it. |
| `apps/web/playwright.config.ts` | Second project `pixel-7-chromium-sw` (SW spec only, `serviceWorkers: 'allow'`); WebKit project ignores the SW spec; optional `PW_CHROMIUM_EXECUTABLE`; `webServer.gracefulShutdown: SIGINT`. |

Tests (all against the production build via `vite build` + `vite preview`, except 4, which needs two builds):

1. **Offline shell** — online visit, wait for the worker to control the page, `setOffline(true)`, reload: the app
   renders (Capture button) and shows the "Offline." banner instead of a browser error page.
2. **Queue through an offline reload** — complete a task offline, wait for the settled "On this device" state, reload
   offline (shell from the SW), read the IndexedDB `pending` store directly (one `CompleteTask`), go online: exactly one
   request reaches the mock, carrying the queued `operationId`; `pending` empties; a further wake-up sends nothing.
3. **`/api/*` never from the SW cache** — after an online `/api/tasks` fetch, no Cache Storage entry has an `/api` path
   (the shell is there); offline, the same fetch rejects rather than returning a body; an offline reload shows no tasks.
4. **New build activates on the next load** — two real production builds of the app (vite API, same config), each with
   one tag statement appended to the entry chunk so asset hashes differ. Serve A, get controlled, switch the server to B,
   reload: B runs immediately (network-first shell), the Cache Storage ends with only B's `vc-shell-<version>`, and an
   offline reload serves B's shell with all of B's assets. Tests `policy.ts`/`sw.ts` as they are.

## WebKit / Chromium split

Playwright routes service-worker network traffic, and applies `setOffline` to it, in Chromium only; the WebKit build
does not support these. So the SW spec runs in a Chromium project (Pixel 7 profile) with service workers allowed, and
the existing `iphone-15-webkit` project keeps everything else, with service workers blocked as before.

## Bug found (not fixed — `apps/web/src/**` is out of scope)

**The offline shell fails to load intermittently when the host sends `Vary: Origin` on assets.**

- `sw.ts` `asset()` looks assets up with `cache.match(request)`, which honours `Vary`. Precache entries are stored via
  `cache.addAll()` from the worker, with requests that carry no `Origin`. `index.html` loads the entry script and CSS
  with `crossorigin`; when that request carries `Origin`, the lookup misses, the worker goes to the network, and offline
  the load fails (`net::ERR_FAILED` on `/assets/index-*.js`), leaving a blank page.
- `vite preview` sends `Vary: Origin` on every file (its CORS middleware). Production asset headers are not decided yet
  (P3-A); any host or proxy that adds `Vary: Origin` triggers the same failure.
- Evidence (test 1 repeated 40× with 4 workers, same `dist/`): **15/40 failed** served by `vite preview`, **0/40**
  served by `static-server.ts` (no `Vary`). While offline, Cache Storage demonstrably held both assets.
- Suggested fix (for the owner of `sw.ts`): `cache.match(request, { ignoreVary: true })` in `asset()` (the keys are
  content-hashed URLs, so `Vary` carries no information). With exactly that one-line change applied temporarily: the SW
  suite passed 3/3 consecutive runs and 40/40 repeats; the change was reverted and is not on this branch.

Tests 1–3 run on `vite preview` as the brief requires and are **kept failing-when-it-happens**; test 4 uses the
`Vary`-free static server, so it does not hit the bug.

## Other findings

- **Playwright never exited** after the suite: it hung at "Terminating the WebServer" (the `pnpm build && pnpm preview`
  tree ignores SIGTERM), leaving an orphaned preview that later runs silently reused. This predates P2-B.
  `gracefulShutdown: { signal: 'SIGINT', timeout: 5_000 }` fixes it (clean exit, no orphan; pnpm prints `ELIFECYCLE`).
- **Reload during an in-flight attempt leaves the item "Saving…" for up to `LEASE_MS` (60 s)**, even after coming back
  online: the reloaded page honours the lease of the attempt it interrupted (A3, by design). Offline attempts fail in
  milliseconds, so the window is tiny; test 2 waits for "On this device" before reloading. Worth a product decision
  whether a lease held by the same (reloaded) tab should be recoverable sooner.

## Verification

Environment: Linux cloud sandbox, Node 22, Playwright 1.63 with the preinstalled Chromium
(`PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`). **No WebKit binary is available here**, so the
`iphone-15-webkit` project could not run.

| Check | Result |
| --- | --- |
| `pnpm check` (lint + typecheck + 454 unit tests) | pass |
| SW suite, unmodified source, 3 consecutive runs | 4/4, 3/4, 3/4 — failures are the `Vary` bug above |
| SW suite, with the temporary `ignoreVary` control patch | 3/3 consecutive runs green; 40/40 on `--repeat-each 10` |
| `app.spec.ts` (8 tests) under a temporary Chromium config, new mock | 3/3 runs green (same as with the old mock) |

Guard-break mutations (each applied alone on top of the control patch, then reverted; `--retries 0`):

| Guard broken | Failing tests |
| --- | --- |
| `policy.ts`: navigations `bypass` (no offline shell) | 1, 2, 3, 4 |
| `policy.ts`: `/api/*` → `asset` (cache-first) | 3 only |
| `queue.ts`: a failed (retry) send is dropped (no offline queue) | 2 only |
| `sw.ts`: shell cache-first (stale shell) | 4 only |
| `sw.ts`: no `skipWaiting()` (new worker waits) | 4 only |

Run locally: `cd apps/web && pnpm e2e` (install Chromium once with `pnpm exec playwright install chromium`).
