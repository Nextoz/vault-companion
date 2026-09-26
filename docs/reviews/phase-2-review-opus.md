# Phase 2 gate review — Claude Opus 5.5 (fresh context, adversarial)

Scope: `main` at `de191ca` (all milestone-1 streams incl. token Undo #14), judged end to end per
`docs/reviews/phase-2-review-brief.md`. Read-only; throwaway scripts ran under the OS temp dir only.

No reachable durable loss, duplication, wrong-task write or auth bypass was found. The two High findings are
availability and sizing: the task **read** path costs one serial GitHub call per `known=` receipt and can lock itself
into permanent failure, and the "Free plan suffices" guidance in `docs/deploy.md` is contradicted by measured
subrequest and CPU costs.

## Findings

| id | severity | file:line | problem | concrete failing input or interleaving | recommended fix |
|---|---|---|---|---|---|
| O1 | **High** | `packages/domain/src/commands.ts:327`; `apps/worker/src/app.ts:96`; `apps/web/src/reads.ts:16,39-46`; `apps/web/src/queue/queue.ts:97`; `apps/web/src/api.ts:24` | `GET /api/tasks` makes **one compare call per `known=` SHA, sequentially**. The client asks about *every* retained receipt (20 acknowledged are kept for good, plus all unacknowledged, plus the watermark; cap 50). Measured with the real `GitHubContentsStore`: known=0 → 2 calls, 21 → 23, 47 → 49, 50 → 52 (+1 token, +1 Access JWKS on a cold isolate). The read is self-locking: a read that fails never acknowledges, so no receipt is evicted and `known` never shrinks. | Phone offline all day; 30 captures/completions queued. Online: 30 receipts arrive and each triggers `refreshTasks` with 20 acknowledged + up to 30 unacknowledged = 50 known. Each read makes 52 serial GitHub round trips. **(a) Any plan:** at ~150–400 ms per compare that is ~8–20 s, and the client aborts reads at `READ_TIMEOUT_MS` = 10 s. **(b) Workers Free:** from ~47 known the 50-subrequest cap throws inside `isAncestor`, so `onError` returns 503. Either way nothing is acknowledged; every later read repeats the failure and the screen stays on the last good read ("refreshing") indefinitely. Even steady state (21 known) is 23 serial calls, about 3–8 s per focus or visibility change. | Bound the read. **Client:** ask only the watermark + unacknowledged receipts (under W1, acknowledged ones stay included and are covered by making the newest acknowledged commit the watermark), with MAX_KNOWN ≤ 8. **Server:** cap `known` to the same N and run the ancestry checks in parallel, or answer them all with one single-page `commitsSince(oldest, X)` (every known SHA listed or equal to X ⇒ included). Add a call-count test per read (like `undo-budget.test.ts`) and a queue test showing a 30-item flush acknowledges and evicts. |
| O2 | **High** | `docs/deploy.md:14-42` (§0); `packages/domain/src/execute.ts:67-119`; `packages/github/src/contents-store.ts:190-211` | Deploy guidance is wrong for the merged code. §0 still sizes the old paged Undo (377) and says "once ADR-0013 is merged … the Free plan suffices"; ADR-0013 is merged. Measured with the real adapter and a counting fake `fetch`: **CompleteTask / CaptureTask / CaptureNote cost 8 + p GitHub calls per attempt** (p = compare pages of `baseRevision..X`): 9 applied at p=1; **50** at p=2 when all 5 attempts are head-moved (+ token + JWKS = 52 > 50); **140** at p=20. The already-applied path is p + 6 (Complete, CaptureTask: replay on the parent) / p + 4 (Note) by construction. Undo stays ≤ 10 × 3 (existing test). **CPU (Free: 10 ms per invocation)**, Node, warm, in-process fake network: CompleteTask 1.4 ms on a 127 B list, **8.5 ms on 28 KB (300 tasks), 29.7 ms on 141 KB (1,500 tasks)**; CaptureTask 6.5 / 29.4 ms; a task read 3.4 / 12.5 ms before any `known` compare JSON is parsed. Cold isolates add JIT and RS256 signing. | A real To-Do List of a few hundred tasks with a busy desktop: an ordinary completion or read is near or over the Free CPU cap. A completion sent after ~10 days offline (hourly sync ⇒ > 250 commits) that meets concurrent desktop pushes exceeds the 50-subrequest cap. Failure is safe (head-CAS; a killed request is an unknown outcome, deduplicated on retry) but the phone sees repeated 503s / timeouts. | Correct `docs/deploy.md` §0 now: the table describes pre-ADR-0013 code; state per-command costs 8 + p (≤ 5 attempts), read cost (O1), and that Free is **not** established for either subrequests or CPU. For the canary, choose Paid, or measure the owner's real list with `wrangler dev --remote` / `wrangler tail` CPU time before relying on Free. Add a call-count test for non-Undo commands (1 page, 20 pages, 5 head-moved attempts). |
| O3 | Medium | `packages/e2e/src/phone.ts:13-67`; `apps/web/e2e/mock-api.ts` | The real PWA queue never runs against the real server stack. The disposable e2e uses a plain-HTTP `Phone` with a five-try loop; every Playwright scenario runs against a mocked API. Receipts → `known` → acknowledgement → watermark → eviction, the Undo draft token fill, and `writeBlock` banners are each tested on only one side of the wire. | O1 is exactly such a seam: every unit and Playwright test passes, but the real queue + real read path lock up after an offline burst. | One Playwright project serving the built web app and the `packages/e2e` harness server on one origin (real Access verifier, `LocalGitStore`), with three flows: offline burst of ≥ 25 actions → online → all acknowledged; complete + Undo before the receipt (draft token); desktop conflict markers → banner → owner resolves → writes resume. |
| O4 | Medium | `packages/e2e/src/server.ts:48-56`; `packages/github/src/local-git-store.ts:45`; `apps/worker/src/index.ts:56-75` | The harness differs from production composition in ways that hide GitHub-only behaviour. `LocalGitStore` truncates dedupe at **250** commits; `GitHubContentsStore` pages up to **20 × 250**, caches commit trees for writes, needs an installation token, and maps 422/409/5xx on the ref PATCH. The harness also omits `createLinkedNoteService` / `createActiveWorkService`, so those endpoints are 404 there. None of the e2e scenarios exercise `createProductionApp`. | A regression in compare paging, `commitsSince` `too-many`, the tree cache feeding a write on the wrong base, or token failure mapping passes the whole e2e suite. Those are covered only by recorded-shape unit tests. | Run the e2e scenarios a second time through `createProductionApp` with a `fetch` shim that serves GitHub REST from the bare repo (compare with `per_page`/`page`, git data, contents, refs). At minimum, compose the harness through the same service spread as `index.ts`. |
| O5 | Medium | `packages/domain/src/commands.ts:163-165`; `apps/web/src/queue/classify.ts:58-67` | Undo's `refused:undo-expired` (and `not-ancestor`) is returned before the own-commit check. The client treats it as "known not applied" (`refused:` prefix), even when an earlier attempt's outcome was unknown. | Undo sent; its ref PATCH lands; the response is lost (timeout ⇒ retry). The phone then stays offline for > 250 commits (~10 days with hourly sync). The resend gets `refused:undo-expired` "undo it in Obsidian". **The task is in fact reopened.** The queue releases same-task successors as if nothing happened, and the owner is told to redo an Undo that already applied. No durable loss, but the save state shown is false. | Server: on `too-many` / `not-ancestor`, answer `dedupe-unknown` (not "known not applied") when the envelope may have been sent before (no signal server-side, so always for `too-many`), with a message saying it may already be applied. Or client: for an `everSent` item whose earlier attempt timed out, never classify `refused:undo-expired` as known-not-applied. |
| O6 | Medium | `apps/web/src/queue/queue.ts:57-60`; `apps/web/src/reads.ts:94-103`; `docs/sync.md:63` | Rendering is gated on the watermark commit being `included`; eviction is gated on receipts being `included`. W1 (no rewrite) is only *recommended* at G2, and the client has no escape if it is ever violated. | The owner repairs history once (force-push or reset `main` to before a canary commit instead of `git revert`, against the runbook). The watermark commit is no longer an ancestor ⇒ every read is `stale` for ever and the app never shows fresh tasks again. Unacknowledged receipts of rewritten commits overlay for ever and hold `known` slots (O1). | Make the `main` ruleset (block force-push and deletion) a **G2 blocker**, not a recommendation, and check it in the deploy runbook. In the client, after N consecutive stale reads, offer "Reset saved-actions history on this device": it clears receipts and the watermark, never pending items. |
| O7 | Medium | `packages/github/src/contents-store.ts:194,236,251` | Every dedupe, `commitsSince` and `isAncestor` call is a `compare`, which returns the range's changed `files` with `patch` text as well as the commits. The response size and parse cost were never probed (`docs/discovery` records status, `total_commits` and paging only). Reads do ~21 of these (O1). | A week of desktop edits: each `known` compare returns every changed note's diff (up to 300 files). That is JSON the Worker downloads and parses per call, which adds CPU against the Free cap (O2), adds latency, and puts private note text in Worker memory (not logged). | Probe response size on the sandbox for a realistic range. If it is large, list commits with an endpoint that carries no patches (`GET /commits?sha=X`, or GraphQL `history`) and keep compare only where `status`/`total_commits` is needed. |
| O8 | Low | `packages/domain/src/commands.ts:337`; `apps/web/src/view.ts:134-137,179-203` | A completion queued offline before midnight and sent after it gets the correct `✅` date (the day of `occurredAt`, A38), but once reflected it is in neither the server's `doneToday` nor the live overlay. The row vanishes with no Done-today Undo. | Complete at 23:55, phone offline, sent 08:00: the task disappears from every list. The only trace is the toast (if still up) and the Saved list. | Keep own receipts from the last session visible in "Done today" (or "Done recently") while their receipt is retained, with Undo. |
| O9 | Low | `apps/web/src/queue/queue.ts:385-412`; `packages/domain/src/execute.ts:76` | A never-sent item keeps the `baseRevision` it was minted with. Its dedupe window grows with the time it waits, although no commit can carry an operation that was never sent. This adds pages (O2) and, beyond 5,000 commits (GitHub) or 250 (`LocalGitStore`), produces a permanent `dedupe-unknown` for a capture that never reached the server. | Capture queued on a phone left in a drawer for months: the first send is `dedupe-unknown`, Retry repeats it, and Export/Discard are the only ways out. | At the first claim (`!everSent`), set `baseRevision` to the newest rendered read revision and persist it with the claim, as the Undo token already is. Bytes are fixed from then on. |
| O10 | Low | `packages/github/src/app-token.ts:21-38` | Token acquisition is not single-flight, and it throws a plain `Error`. On a cold isolate, concurrent requests each mint a token (an extra subrequest each). Failures reach the client correctly (503 retryable via `onError`) but skip the executor's typed path and its log `errorCode`. | Two tabs flush at once after an isolate recycle: 2 token POSTs; a token outage is logged as a generic internal error. | Share the in-flight promise; throw `StoreUnavailable` from the token source. |
| O11 | Low | `apps/web/public/_headers:3`; `apps/web/vite.config.ts` (meta CSP); `apps/web/playwright.config.ts` | Production enforces two CSPs: header (`form-action 'self'`, `frame-ancestors 'none'`, no `manifest-src`/`worker-src`) and meta (`form-action 'none'`, `manifest-src`/`worker-src 'self'`). The UI suite runs on `vite preview`, which never serves `_headers`, so the effective intersection is untested with the app. | No failing input found (the renderer emits no inline style or remote image; the SW, manifest and `connect-src` fall back to `'self'`). The risk is a future change that passes CI and breaks on the real host. | One Playwright smoke against `wrangler dev` (serves `_headers`) that loads the app, opens a linked note and checks for no CSP violations. |

## Evidence run

- `pnpm test`: 47 files / **759 passed**; `pnpm typecheck` and `pnpm lint` clean at `de191ca`.
- **Read budget (O1):** throwaway Vitest script under the OS temp dir. It drives `createCommandService` +
  `GitHubContentsStore` with a counting fake `fetch`. `readTasks(known)` for 0/21/47/50 SHAs made 2/23/49/52 GitHub
  calls, and `commands.ts:327` awaits each `isAncestor` in turn.
- **Write budget (O2):** same method; window of 10 / 300 / 5,000 commits × ref update 200 / always 422. For each of
  CompleteTask, CaptureTask and CaptureNote: 9/45, 10/50, 28/140 calls. Undo: covered by the existing
  `packages/github/src/undo-budget.test.ts` (≤ 10 per attempt, 3 attempts).
- **CPU (O2):** same script, synthetic lists of 1 / 300 / 1,500 tasks (127 B / 28 KB / 141 KB), timed after 5 warm
  reads and 3 warm writes (Node 22, not workerd). Numbers are in O2.
- **Disposable e2e (`packages/e2e`)** against `docs/testing.md` "Disposable end-to-end": app→desktop (l.137),
  desktop→app (157), dirty desktop (244), compatible divergence (257), same-task conflict (290, 306), same-anchor
  conflict (432), remote race (336, 406, 470), remote unavailable (359) and lost response (203) are all present. Each
  asserts exact bytes, commit counts and heads, so none is vacuous; for example, l.203 fails if the executor's dedupe
  branch (`execute.ts:79`) is removed, because the retry would write a second commit and `commitsFor` would return 2.
  `docs/sync.md` W1–W5 are modelled by `desktop.ts` (a model, stated as such; the real worker is unverified).
- **Phase 1 Critical/High spot-check under the real loop:**
  - A2 head-CAS: e2e l.406 (real `update-ref` collision).
  - A1 exact Undo: e2e covers only the semantic path (l.519, after a desktop edit); the exact-bytes path is unit-only.
  - A3 cross-tab: Playwright (mock API) `app.spec` l.141 and `draft.spec` l.91.
  - A7 account binding: unit/HTTP only.
  - A4 Inbox race: closed structurally by head-CAS; no e2e.
  - A6 JWT `exp`: unit.

## Item 0 — overlaps between streams

- **IndexedDB:** one database `vault-companion` v4, four stores created additively (`db.ts:228-238`). The Capture
  Save deletes the draft and persists the queue item in one transaction (CAS on draft version). `onversionchange`
  closes old connections; their failures surface as "Could not keep this on the device", with the text kept
  (`CaptureSheet.tsx:128-131`). Sound.
- **Service worker vs note view and drafts:** `/api/*` is bypassed (`policy.ts:7`); notes are never cached; drafts
  live in IndexedDB, not the SW cache. Shell caching refuses redirects (the Access login). Sound.
- **Task identity vs Undo-in-Done-today vs conflict UI:** Done-today pairs a receipt with a done line only when both
  are unique by text (`view.ts:186-202`); Undo refuses when the completed line had a twin in `C`
  (`commands.ts:107-111`). Sound. The midnight gap is O8.
- **`_headers` CSP vs note renderer:** the renderer emits no inline styles or remote images and only http(s) links
  with `rel`/`target`. It is compatible, but untested under the header CSP (O11).

## Item 5 — delayed offline captures (hours to days)

- **Dedupe window:** grows by the desktop commits since `baseRevision`: 1 page at ≤ 250 commits (~10 days of hourly
  sync), 20 pages at most, then `dedupe-unknown`. Safe, but it costs budget (O2), and for never-sent items it is
  avoidable (O9).
- **Stale base:** the command is re-planned against the current head. The locator matches by exact line text when the
  blob changed, so a task edited or completed on the desktop meanwhile gives `conflict:task-changed` (e2e l.290),
  which is shown, not hidden.
- **Capture anchor:** top of Open at send time (ADR-0010). Desktop QuickAdd at the end merges cleanly (e2e l.275). With
  committed conflict markers, every To-Do write is refused, and Retry is offered only after a fresh read is no longer
  write-blocked (`app.spec` l.443).
- **Dates across midnight:** `➕` / `✅` use the day of `occurredAt` in Europe/Copenhagen (A16/A38, unit). The UI gap is
  O8. `clock-skew` refuses more than 5 minutes ahead; a later Retry of the same bytes succeeds.
- **Draft vs queue:** a draft becomes a queue item atomically at Save. `occurredAt` is the Save time, not the typing
  time, so a draft kept overnight is dated the day it is saved. That is acceptable, but should be documented.
- **Undo after long offline:** `refused:undo-expired` beyond 250 commits since `C`. That is fine, except when an earlier
  attempt's outcome was unknown (O5).

## Item 6 — request budget per write command (GitHub calls; + 1 token and + 1 Access JWKS on a cold isolate)

| Command | per attempt, not yet applied | already-applied | attempts | worst case | Workers Free (50) |
|---|---|---|---|---|---|
| CompleteTask | 8 + p (ref, p compare pages, file, tree, base commit, blob, tree, commit, ref PATCH) | p + 6 | 5 | 5 × 28 = 140 (+2) | exceeded from p = 2 with 5 head-moved attempts; single attempt ≤ 30 fits |
| CaptureTask | 8 + p | p + 6 | 5 | 140 (+2) | as above |
| CaptureNote | 8 + p (+2 if `Inbox/` is absent) | p + 4 | 5 | 140 (+2) | as above |
| UndoCompleteTask | ≤ 10 (ADR-0013, tested) | ≈ 7 | 3 | 30 (+2) | fits |
| Task read (`/api/tasks`) | 2 + known (serial) | — | 1 | 52 (+2) | **exceeded from ~47 known; see O1** |

GitHub's ~5,000/h installation limit is not at risk for one user's writes. Reads are the dominant cost: ~23 calls per
read in steady state × every focus, visibility change, `online` and receipt event. Under a fix for O1 this drops to
≤ 10.

## Item 7 — phone experience: verified vs untested

| Area | Verified (how) | Untested |
|---|---|---|
| Today usefulness (Today rule, Overdue group, Active Work Now card) | Playwright WebKit iPhone viewport, mocked API (`app.spec` l.343, 537, 598); rule unit tests | Real vault content; read latency with real `known` (O1: 3–20 s) |
| Capture speed and double-tap safety | Playwright (A40), draft specs | Real device keyboard/latency; standalone PWA launch time |
| Draft recovery | `draft.spec` (reload, two windows, discard) | iOS killing the PWA in background; storage eviction (`navigator.storage.persist` best-effort) |
| Save / conflict states | Playwright state specs with mocks (refusals, clock-skew, vault-conflict, signed-out) | States driven by the real server (O3), including the stuck-read case (O1) |
| Safe Undo | Domain/unit, e2e l.519/548 (token), Playwright toast and Done-today Undo | Undo across midnight (O8); Undo after long offline with a lost response (O5) |
| Readable linked context | Playwright (sanitised, not stored, focus trap); XSS corpus | Header CSP on the real host (O11); large notes on device |
| Offline shell | `offline-shell.spec` (Chromium in CI; WebKit per config) | iOS Safari SW update/activation in standalone mode |
| Sign-in | HTTP auth matrix; signed-out banner (mock) | **Cloudflare Access login inside an iOS standalone PWA** (redirect out of scope, cookie jar, return to the app); Access session expiry mid-flush on a real phone |

## Phase 3 blockers (ranked)

1. **O1**: bound the read path (client asks watermark + unacknowledged, ≤ 8; server cap and single-call answer)
   before daily use. Otherwise the first offline burst locks reads on any plan.
2. **O2**: correct `docs/deploy.md` §0 and decide the plan with measured numbers. Until the owner's real list is
   measured, deploy the canary on Paid.
3. **O6 / W1**: make the `main` ruleset (no force-push, no deletion) mandatory at G2 and verify it before G3.
4. The real Windows sync worker: prove W2 and the W4 representation (the harness assumes markers are committed) on
   the canary, as `docs/sync.md` already requires.
5. A real-iPhone smoke of the Access login in standalone mode, offline capture → online, and an Undo, before G3
   (item 7).
6. O3/O4 are recommended before G3 but not blocking, provided 1–3 are fixed with their own call-count and queue tests.

## What is sound

- **Write safety:**
  - Head-CAS (ADR-0011) with fast-forward-only ref updates, `expect` preconditions in the pinned tree, and
    unknown-outcome handling that never resends blindly (`execute.ts:100-107`).
  - Across unit, real-Git and e2e, no interleaving produced a duplicate or a lost write. Exceeding a Workers limit
    mid-attempt degrades to `upstream-unavailable` / unknown outcome, which is then deduplicated.
- **Token Undo (ADR-0013):** the token is verified by trailer and payload hash; one bounded listing answers ancestry,
  own-dedupe and double-Undo; `deriveApplied` proves `U` is the inverse; ambiguous twins are refused. Budget-tested.
- **Client queue:**
  - Durable-before-send; identical bytes on every attempt; Web Locks with re-read state.
  - Account binding checked on both sides; `knownNotApplied` consulted only for `attention` items, so a retryable
    `conflict:stale` never releases a dependent.
  - The Undo draft token is filled and persisted before the first send.
- **Conflict visibility:** committed markers ⇒ `writeBlock` banner and server-side `refused:vault-conflict`; nothing
  is written into a conflicted file (e2e l.306, 432).
- **Deploy surface:** `/api/*` behind Access with origin + custom-header CSRF checks; `workers_dev` / `preview_urls`
  off; static security headers; secrets never committed.

## Verdict

**PASS WITH FIXES.** No Critical findings. O1 and O2 (High) must be fixed before the first live write (G3). O5 and O6
should land with them.
