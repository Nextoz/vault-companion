# Report P2-A — Phase 2 disposable end-to-end harness

Branch `agent/e2e-harness`. Brief: `docs/briefs/P2A-e2e-harness.md`.

## What was built

New private workspace package `packages/e2e` (Node only, tests only):

| File | Role |
|---|---|
| `src/server.ts` | Test harness, **not a production entry**. The real `createApp` + real `createAccessVerifier` (locally generated RS256 JWKS, signed tokens, no bypass) + real `createCommandService` over `LocalGitStore` on a temp bare repo, hosted with `@hono/node-server` on `127.0.0.1:<ephemeral>`. Fault injection: `dropNextCommandResponse()` destroys the socket *after* the command ran to completion. |
| `src/desktop.ts` | Desktop clone + `sync()`: a **model of the W1–W5 contract, not the real Windows worker** (stated in the file header). Commit local → fetch → merge (never rebase, never force) → plain push, retrying on a push race. W4 representation: conflicted merge committed **with markers** and pushed, conflicted files reported. |
| `src/phone.ts` | Phone-like client over `fetch`: envelopes validated with `Command`; answers parsed with `Receipt` / `ApiError` / `TasksResponse` / `SessionResponse`. `sendUntilSettled` resends the identical envelope on retryable errors (queue behaviour). |
| `src/git.ts` | Hermetic git helpers: `GIT_CONFIG_GLOBAL` → empty file, `GIT_CONFIG_NOSYSTEM=1`; each repo gets its own `user.name`/`user.email`/`core.autocrlf=false`/`commit.gpgsign=false`. |
| `src/e2e.test.ts` | 15 scenarios (below). |

Also changed: root `tsconfig.json` (reference), `pnpm-lock.yaml` (`@hono/node-server@2.1.1`; `hono` pinned to the
worker's resolved 4.13.8 so there is one copy). No other package or app was modified.

`createApp`/`createAccessVerifier` are imported by relative path from `apps/worker/src` because the worker package
only exports its Workers entry; the tsconfig project reference to `apps/worker` makes that typecheck.

## Scenarios and results

Fixed clock `2026-09-24T10:00Z` (Copenhagen date 2026-09-24); synthetic seed (frontmatter, `## Open` with six tasks,
`## Done` with one). Every scenario asserts the **exact bytes** of the file(s) in the desktop clone after sync.
An `afterEach` also asserts that no task/note word or clear-text vault path reached the server log sink (A18).

| # | Scenario | Result |
|---|---|---|
| 1 | app → desktop completion, **LF** — receipt effect, fast-forward sync, desktop HEAD = receipt commit, blob = receipt blob, trailers `Vault-Companion-Op`/`-Payload` present, no task text in the message | pass |
| 2 | same, **CRLF** file (bytes preserved end to end) | pass |
| 3 | desktop → app: desktop edit synced; next read serves the new revision, blob and line | pass |
| 4 | capture task lands at the top of Open (ADR-0010) | pass |
| 5 | capture note: exact Inbox file bytes (frontmatter, quoted wikilink context, body); To-Do List untouched | pass |
| 6 | lost response: server commits, socket destroyed before the answer; retry ⇒ `already-applied`, same commit, one commit | pass |
| 7 | double submit (two identical requests in flight) ⇒ `applied` + `already-applied`, one commit | pass |
| 8 | dirty (uncommitted) desktop edit to another task + app completion ⇒ sync commits first, merges, both survive, app commit reachable (W1) | pass |
| 9 | compatible divergence: desktop local commit + two app commits ⇒ merge commit with parents [desktop, app], nothing lost | pass |
| 10 | desktop QuickAdd append at end of Open + app capture at top ⇒ **clean merge** (the ADR-0010 claim) | pass |
| 11 | same task, desktop edit published first ⇒ app `409 conflict:task-changed`, not retryable, no commit | pass |
| 12 | same task, concurrent (desktop edit unsynced, app completes) ⇒ sync commits markers preserving the desktop's edited line; the app's completion is in Done; no edit lost. Then read has `writeBlock: refused:vault-conflict` and a capture is `422 refused:vault-conflict` with no commit | pass |
| 13 | remote race: 3 captures + 1 completion concurrently ⇒ all 200, each operation exactly one commit, linear history, bytes match commit order | pass |
| 14 | upstream unavailable (bare repo renamed away) ⇒ read and write `503 upstream-unavailable retryable:true`; after restore the same envelope ⇒ `applied`, one commit | pass |
| 15 | stale read: desktop inserts a task above the target after the phone read ⇒ completion with the stale locator replans on the new head (parent = desktop commit), `known` reports the receipt `included`, desktop edit kept | pass |

Stability: the e2e file passed 3 consecutive runs (~4 s each).

### Guard checks (AGENTS.md rule 7)

Temporarily broken production code, then restored (no production diff on the branch):

| Mutation | Failing scenarios |
|---|---|
| `LocalGitStore.writeFile`: `update-ref` without the expected old value (no head-CAS) | 7 double submit, 13 remote race |
| `executeWrite`: ignore a `found` dedupe hit | 6 lost response, 7 double submit |

## Verification

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` — all green (28 files, 458 tests; 15 new).
Run in the cloud container on Node 22.22.2, git 2.43.0.

## Production defects found

None. No scenario required a production change, and none was made.

## Observations (not defects; for the lead)

1. **Reads during a committed-markers conflict.** In scenario 12, `GET /api/tasks` correctly sets
   `writeBlock: refused:vault-conflict`, but the task views still include the line inside the marker region
   (`Water the plants … 📅 2026-09-30` listed as open) **and** its completed copy in `doneToday`. Writes are blocked,
   so nothing can go wrong in the vault, but the UI must lead with the conflict banner rather than present these
   views as authoritative. Worth a check in the web app's handling of `writeBlock`.
2. **Shape of the most likely same-task conflict.** Desktop-modified vs app-deleted gives an empty `theirs` side in
   Open (`=======` directly followed by `>>>>>>> origin/main`); the completed line sits cleanly in Done. The owner
   resolves by deleting the marker block (or the Open line). Useful for the canary checklist wording.
3. **W4 representation chosen by the model:** markers committed and pushed. The real worker may choose conflict-copy
   or blocked sync instead; `docs/sync.md` requires that choice be explicit — still open for the canary gate.
4. **Hermeticity.** The cloud machine's global git config has `commit.gpgsign=true` and `push.negotiate=true`; the
   harness shuts global/system config out entirely. `LocalGitStore` takes its environment only from `process.env` at
   construction, so the harness scopes the hermetic variables around the constructor. An explicit `env` option on
   `LocalGitStore` would be cleaner (not changed: out of scope for this brief).
