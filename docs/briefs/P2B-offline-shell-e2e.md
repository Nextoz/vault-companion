# Brief P2-B — Service-worker offline shell e2e

Type: **test implementation** (bounded). Branch `agent/offline-shell-e2e`. Runs as a **Claude Code Cloud** task (Linux).

## Objective

Close risk "Service-worker offline shell not e2e-tested" (`docs/plan.md`). Prove with Playwright against the
**production build** (`vite build` + `vite preview`, not the dev server) that:

1. After one online visit, the app shell loads with the network offline (`context.setOffline(true)`) and shows the
   queued/offline state rather than a browser error page.
2. A task completed while offline stays queued in IndexedDB and is sent exactly once when back online (mock API
   counts requests; the existing `apps/web/e2e/mock-api.ts` may be extended).
3. `/api/*` responses are **never** served from the service-worker cache (`docs/security.md` "Caching"): after going
   offline, an `/api/tasks` fetch fails rather than returning a cached body.
4. A new build (changed asset hash) activates on the next load without serving a stale shell forever
   (`apps/web/src/sw/policy.ts` defines the intended update behaviour — test that, do not change it).

Use a Chromium project for service-worker tests if WebKit's Playwright build cannot run service workers; keep the
existing WebKit project for everything else and explain the split in the report.

## May change

`apps/web/e2e/**`, `apps/web/playwright.config.ts`, `apps/web/package.json` (scripts/devDeps), lockfile,
`docs/briefs/P2B-report.md`.

## Must not change

Application source (`apps/web/src/**`). If a test exposes a real bug, stop, keep the failing test, and describe the
bug in the report instead of fixing it.

## Verify and report

All web e2e green, 3 consecutive runs, and each new test shown to fail once when its guard is broken (for example:
cache `/api/*` in the SW, or skip the offline queue). Report `docs/briefs/P2B-report.md`. **Push early** (report
stub within the first minutes), push again when done. Final line: `P2B DONE <commit-sha> — docs/briefs/P2B-report.md`.
