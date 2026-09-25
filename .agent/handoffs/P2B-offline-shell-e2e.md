# Handoff — P2-B offline shell e2e

## Completed

- `apps/web/e2e/offline-shell.spec.ts`: 4 Chromium tests on the production build: offline shell, a completion queued
  in IndexedDB through an offline reload and sent exactly once, `/api/*` never served from the SW cache, and a new build
  activating on the next load.
- `static-server.ts` (swappable-root server for the two-build test); `mock-api.ts` gained context routing and a
  `network: 'down'` switch.
- `playwright.config.ts`: `pixel-7-chromium-sw` project for the SW spec, WebKit ignores it, optional
  `PW_CHROMIUM_EXECUTABLE`, SIGINT webServer shutdown.
- Report: `docs/briefs/P2B-report.md`.

## Important discoveries

- **Real bug in `apps/web/src/sw/sw.ts` (not fixed):** `asset()` calls `cache.match(request)`, which honours `Vary`.
  `vite preview` sends `Vary: Origin`, and the page's `crossorigin` requests sometimes carry `Origin` while the precache
  requests don't, so the offline load fails with a blank page. 15/40 failures with preview vs 0/40 without `Vary`.
  Production is exposed if its asset host adds `Vary: Origin` (P3-A hasn't decided those headers yet).
- Before this change, Playwright never exited: it hung terminating the `pnpm build && pnpm preview` webServer and left
  an orphaned preview that later runs silently reused. Fixed in the config.
- Reloading while a send is in flight leaves the item "Saving…" for up to 60 s (the lease, A3). This is by design,
  but it's a UX edge.
- This cloud session started with **no `origin` remote** (bundle upload). It pushed only after the repository was attached with push access.
- No WebKit binary exists in this sandbox; Chromium is at `/opt/pw-browsers/chromium` (Playwright 1.63 expects a newer
  revision, hence the env override).

## Recommend

- **Fix now:** `cache.match(request, { ignoreVary: true })` in `sw.ts` `asset()`. It's one line and was verified
  locally (3/3 runs, 40/40 repeats), then reverted. Until it lands, the new SW tests are intermittently red.
- **Follow-up:** in P3-A, make sure the Worker's static-asset responses don't vary on `Origin`. Decide whether a
  reloaded tab may reclaim its own lease sooner.
- **Leave alone:** the WebKit/Chromium split. WebKit's Playwright build can't route or take SW traffic offline.

## Verification

- `pnpm check`: lint, typecheck and 454 unit tests all pass.
- SW suite on unmodified source, 3 consecutive runs: 4/4, 3/4, 3/4. Every failure is the `Vary` bug.
- With the temporary `ignoreVary` patch: 3/3 consecutive runs green, 40/40 with `--repeat-each 10`.
- Each guard broken alone fails its test(s): shell bypass → 1–4; `/api` cached → 3; offline queue dropped → 2;
  cache-first shell → 4; no `skipWaiting` → 4.
- `app.spec.ts` (8 tests) passes under a temporary Chromium config, 3/3 runs. The WebKit project was not run (no binary).

## Commit

- `5a7517b` test(web): service-worker offline shell e2e on the production build (P2-B), on
  `agent/offline-shell-e2e`, plus this handoff commit.
- Pushed to `origin/agent/offline-shell-e2e` once the repository was attached with push access. The session
  started without an `origin` remote (bundle upload).
