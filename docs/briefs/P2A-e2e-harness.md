# Brief P2-A — Phase 2 disposable end-to-end harness (real Git)

Type: **implementation**. Branch `agent/e2e-harness`. Runs as a **Claude Code Cloud** task (Linux).

## Objective

Prove the real write/read loop with real Git and no mocks, as `docs/testing.md` "Disposable end-to-end" and roadmap
Phase 2 describe. Create `packages/e2e` (private workspace package, Node only):

1. **Server:** the real `createApp` (`apps/worker/src/app.ts`) with `createCommandService` over `LocalGitStore`
   (`@vault-companion/github/local-git`), hosted on Node via `@hono/node-server`, on a temp bare repo. Auth uses the real
   `createAccessVerifier` with a locally generated JWKS and signed tokens (no auth bypass). This is a test harness,
   not a production entry.
2. **Desktop:** a clone of the same bare repo plus a function `desktopSync()` that behaves like the sync-worker
   requirements W1–W5 in `docs/sync.md`: commit local edits first, then fetch and merge (never rebase published
   history, never force). On a textual conflict it must preserve both sides and report the conflict, never discard.
   Document in the file header that this is a model of the contract, not the real Windows worker.
3. **Phone-like client:** plain HTTP calls with the real contracts (`Command`, `Receipt`, `TasksResponse` parsed with Zod).

## Scenarios (Vitest, each asserts exact Markdown bytes in the desktop clone after sync)

app → desktop completion; desktop → app edit visible in the next read; capture task (lands at top of Open, ADR-0010) and
capture note; retry after a lost response (inject by dropping the HTTP response after the server committed) ⇒ one commit;
double submit ⇒ one commit; dirty desktop edit to another task + app completion ⇒ both survive after sync; compatible
divergence (desktop commits, app commits, then sync); same-task conflict ⇒ app refuses or desktop sync preserves both,
and the file never contains a lost edit; desktop QuickAdd-style append at the end of Open + app capture at the top ⇒
clean merge (the ADR-0010 claim); remote race (concurrent app commands) ⇒ no duplicate; upstream unavailable (bare repo
temporarily unreadable) ⇒ 503 retryable, then success; stale read (desktop commit after the client read) ⇒ the next
command replans safely. Use synthetic text only.

## May change

New `packages/e2e/**`; root `tsconfig.json` reference; `pnpm-lock.yaml`; `docs/briefs/P2A-report.md`.

## Must not change

Any other package or app. If production code looks wrong, write a failing scenario and describe it in the report.
Do not fix it silently.

## Verify

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` green. Git must be configured by the tests themselves
(user.name and user.email per repo). Commit and push `agent/e2e-harness`. Report in `docs/briefs/P2A-report.md`
(scenarios, results, any production defects found). Do not open a PR or spawn agents.
