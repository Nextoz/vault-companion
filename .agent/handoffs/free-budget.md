# Handoff — every write command fits Workers Free (`agent/free-budget`)

Decision: `docs/decisions/0015-bounded-write-budget.md`. Review: `docs/reviews/phase-2-review-astra.md` P2-A1, P2-A4.
Branched from `agent/read-budget` (`00b46c6`), so it includes O1/O5/O6.

## Completed

1. **One compare page for every dedupe.**
   - `executeWrite`'s default dedupe is now `findInOnePage`: one `commitsSince(baseRevision, X)`.
   - More than one page, or a base that is not an ancestor, ⇒ `dedupe-unknown` "this may already be applied — check
     Obsidian". Never paged, never a write.
   - Own-operation hit ⇒ `readCommit` for its paths, then the existing replay verification.
   - Undo keeps its own ADR-0013 check.
2. **`MAX_ATTEMPTS = 3`** for every command.
3. **Client moves a never-sent item's base forward.**
   - `PendingQueue` takes a `latestRevision` option (`main.tsx` passes `prefs.lastRevision`, which each applied read
     updates).
   - In `#claimNext`, if the record was never sent, its envelope's `baseRevision` becomes that revision. This happens
     together with any Undo token fill, and the body is persisted **with the claim** before the request leaves.
   - From then on every attempt, other tabs and reloads resend identical bytes. An item that may have been sent is
     never touched.
4. **CaptureNote with an absent Inbox.** `GitHubContentsStore` now:
   - memoises settled directory listings per `(commit, dir)`, so the planning listing also serves the write
     precondition;
   - records the base tree from the root listing's `sha` and from every commit in a compare page.

   It never needs `GET /git/commits/X`. Caches are keyed by immutable SHAs and dropped at 256 entries.
5. **A4: Done today by date.** A completion overlay enters Done today only if `dateIn(occurredAt, read.timeZone) ===
   read.today`. The open row stays hidden either way, and the action stays in Actions. `dateIn` (Intl, zone calendar) is
   in `apps/web/src/time.ts`.
6. **Docs:**
   - ADR-0015 with the measured table;
   - `docs/commands.md` execution algorithm (dedupe step, 3 attempts, one page, the client's base refresh);
   - `docs/deploy.md` §0: Free suffices for subrequests, with measured worst cases; CPU is still to be measured (O2).

## PR #15 review fixes (after merging `origin/main`)

`docs/deploy.md` §0 conflicted with main's owner decision. Both are kept: the bounded measured table replaces the
superseded "8 + p, ≤ 5 attempts" row, and main's Free decision and CPU guidance stay.

- **F1:** a view test for the O1 fallback. An unacknowledged receipt that the rendered read did not answer keeps
  overlaying. It fails if the fallback becomes `'included'`; only this new test catches that mutation.
- **F2:** `resetHistory()` keeps the receipts a pending Undo draft still needs for its token. The rule is shared with
  `#evictable` through `#neededByDrafts()`. Kept receipts become **unacknowledged**: the neutral watermark no longer
  covers them, so reads ask about them again.
  - Test: an unsent draft survives the reset; the unrelated receipt is dropped; the draft then sends its token.
  - Mutations "drop all" and "kept stays acknowledged" each fail it.
- **F3:** the reset banner adds "a recently saved action may briefly show as not yet reflected"; the O6 Playwright
  spec asserts it.

## Measured budget (`packages/github/src/write-budget.test.ts`)

Worst case: a full 250-commit dedupe page, the head moving on every attempt (nothing cached carries over), 3 lost ref
races, a cold installation token, +1 Access JWKS.

| Command | GitHub requests | + JWKS | Limit |
|---|---|---|---|
| CompleteTask | 25 (1 token + 3 × 8) | 26 | 50 |
| CaptureTask | 25 | 26 | 50 |
| CaptureNote, Inbox present | 22 (1 + 3 × 7) | 23 | 50 |
| CaptureNote, Inbox absent (Astra: 56) | 25 | 26 | 50 |
| CompleteTask / CaptureTask already applied, found on the full page | 8 (incl. token) | 9 | 50 |
| CaptureNote, absent Inbox, nothing since the base | 9 (incl. token) | 10 | 50 |

The tests also assert:
- ≤ 8 store requests per attempt;
- one compare per attempt;
- no tree listed twice for the same commit;
- no `GET /git/commits/`;
- exactly one token request.

## Important discoveries

- My first version of the budget test **undercounted**: its fake head never moved, so per-commit caches carried across
  attempts (23 instead of 25). The final fake returns a new head on every ref read. Worth keeping in mind for any
  future budget fake.
- **The A4 filter exposed a test-environment gap:** `app.spec.ts` minted actions with the real clock (2026-09-26)
  against a mock whose reads are dated 2026-09-24. Three specs failed until the page clock was pinned to the mock's day
  in `beforeEach`; the two per-test `clock.install()` calls were folded into it. View-test fixtures were pinned the same
  way (`ON_READ_DAY`).
- The store port's paged `findOperation` is now unused by every command. It is kept, with its contract tests, for a
  separate removal; the GitHub `maxComparePages` option is dead with it.
- **Residual (in the ADR):** a command applied with a lost response, then retried after more than 250 further commits,
  answers `dedupe-unknown`, never a second write. Because of item 3, that needs a burst of commits between the first
  send and a retry, not merely a long wait before the first send.
- Astra's other items are not in this task: P2-A2 is addressed by read-budget (O1); P2-A3 is the combined acceptance
  loop and the worker's blocked-conflict mode. The optional "refresh the displayed day across midnight while the app
  stays open" from P2-A4 is also not done: `today` comes from each read, so it updates on the next read (focus or
  visibility).

## Recommend

- Measure CPU (Free: 10 ms) on the owner's real list before G3 (review O2); subrequests are no longer the limit.
- Remove `findOperation` / `maxComparePages` in a small follow-up once no test depends on them.

## Verification

- `pnpm check`: **green**, 49 files, 793 tests (after the PR #15 fixes).
- Playwright (`vite build`, Chromium, iPhone 15): `app.spec.ts` 34/34 after the clock pin. The 5 `offline-shell`
  specs fail in this sandbox as before (service worker never takes control under this Chromium; same on a clean main).
- **Guards broken once, each confirmed to fail its tests:**

  | # | Mutation | Caught by |
  |---|---|---|
  | F1 | paged `findOperation` dedupe again | execute A32/F9 + lost-response; GitHub one-compare-per-attempt (6 tests) |
  | F2 | `too-many` treated as not-found | execute beyond-one-page + lost-response; GitHub one-page test |
  | F3 | not-ancestor treated as not-found | execute unknown-base |
  | F4 | `MAX_ATTEMPTS` 5 | execute constant; GitHub PATCH count (5 tests) |
  | F5 | listing cache disabled | GitHub CaptureNote per-attempt/no-repeat (2 tests) |
  | F6 | root listing tree not remembered | GitHub CaptureNote absent Inbox, nothing since base |
  | F7 | compare trees not remembered | GitHub budget tests (8) |
  | C1 | rebase an item already sent | queue: already-sent keeps base; identical bytes after reload |
  | C2 | never rebase | queue: rebased before first send |
  | A1 | Done today not dated | view: pending and saved-unreflected across midnight |

## Commit

Branch `agent/free-budget`, pushed. Final SHA in the session report.
