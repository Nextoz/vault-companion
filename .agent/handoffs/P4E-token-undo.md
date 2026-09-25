# Handoff — P4-E token-based Undo (`agent/token-undo`)

Spec: `docs/decisions/0013-token-undo.md`. Brief: `docs/briefs/P4E-token-undo.md`. Base: `origin/main` `d39b005`
(includes PR #9).

## Completed

- **Contract** (`packages/contracts`)
  - `UndoCompleteTask.payload.targetCommit` (40-hex, required).
  - New `ErrorCode` `refused:undo-expired` (the Worker maps `refused:*` to 422).
- **Store port** (`packages/domain/src/store.ts`)
  - `readCommit(sha)`: trailers, first parent, and changed files with their blob SHAs; `null` if the commit is unknown.
    One request.
  - `commitsSince(base, until)`: `ok` with the commits (with trailers) if they fit in **one** page of
    `COMPARE_PAGE = 250`; otherwise `too-many` or `not-ancestor`. Never pages.
  - `gitBlobSha` moved into domain; `testing` re-exports it.
- **Executor** (`execute.ts`)
  - Plans may bring their own dedupe (`findApplied`, which can also refuse) and `maxAttempts`.
  - Other commands are unchanged: they still use the paged `findOperation` over `baseRevision..X` (ADR-0005).
- **Undo plan** (`commands.ts`, `undoPlan`). Per attempt at X:
  - `readCommit(C)`: unknown ⇒ `conflict:task-changed`; Op trailer ≠ target op, or payload trailer ≠ target hash ⇒
    `invalid`.
  - One `commitsSince(C, X)`:
    - not an ancestor ⇒ `conflict:task-changed`;
    - more than one page ⇒ `refused:undo-expired`;
    - own op ID present ⇒ dedupe, `already-applied` with the same commit;
    - another `Vault-Companion-Undoes` of the target ⇒ `conflict:task-changed`.
  - C must change only the task list. Replaying the target on `C^` must hash to C's blob, so C's file is never read.
  - Then the exact-bytes inverse (X's blob == C's blob ⇒ write `C^` bytes) or the semantic inverse, unchanged.
  - `UNDO_MAX_ATTEMPTS = 3`. `deriveApplied` re-derives the effect from the verified completion.
- **Adapters**
  - GitHub:
    - `readCommit` = `GET /commits/C`: message, parents, tree and `files[].sha`.
    - `commitsSince` = one `compare C...X?per_page=250&page=1`; `total_commits > 250` ⇒ `too-many`.
    - Tree SHAs seen in those two responses are cached, so the write skips `GET /git/commits/X`.
  - Local git and in-memory: same semantics. In-memory `comparePageSize` is configurable, and every call is logged
    in `calls`.
- **Client** (`apps/web`)
  - Undo is minted with the receipt's `commitSha` when the device holds the receipt (the toast after it is saved,
    and every Done today Undo).
  - Before a receipt exists, `undoDraft` is queued without a token. `#claimNext` fills the token from the completion's
    receipt, and it is persisted **with the claim, before the request leaves**, so retries and reloads resend
    identical bytes.
  - A draft whose completion ends refused (known not applied) is dropped locally.
  - A draft with neither its completion nor its receipt on the device → attention, `refused:undo-target-unknown`,
    never sent.
  - A receipt that a draft still needs is never evicted.
- **Tests**
  - Domain: forged token (other op; wrong payload hash; right trailers but other content), unknown token, token not
    an ancestor (even when head holds identical bytes), lost-response retry ⇒ `already-applied` with the same commit,
    second Undo refused, `undo-expired` beyond one page (page size 3), exact and semantic inverse (A3/A4/A5, A1/R1
    gate cases), call budget (≤ 10 store calls, no `findOperation`, one `commitsSince`), ≤ 3 attempts.
  - Store contract (in-memory + real git): `readCommit`, `commitsSince`.
  - GitHub adapter: `undo-budget.test.ts`, a full Undo through the command service over a fake API serving
    kernel-produced bytes.
  - Client: queue draft tests; the web e2e mock verifies the token.
  - `packages/e2e` (real Git): Undo by token after a desktop edit (semantic inverse keeps the edit, resend ⇒
    `already-applied`, second Undo refused, `Undoes` trailer); forged or unknown token refused, nothing written.
- **Docs:** `docs/commands.md` Undo section (payload, per-attempt algorithm, client drafts).

## Important discoveries

- **Measured budget:** exactly **10 GitHub calls per Undo attempt**, whether 0, 1 or 250 commits lie between C and X:
  ref, `/commits/C`, compare, contents at `C^`, contents at X, trees at X for the precondition, then
  blob/tree/commit/ref. That is ≤ 30 over 3 attempts, with no paging. The ADR's "≈ 10" leaves out the write's
  precondition tree read and base-commit read; reusing the tree SHA from the compare response brings it back to 10.
- `packages/e2e` had **no** Undo scenario before; two were added.
- **Outside the owned-file list (necessary):** `apps/worker/src/wiring.test.ts` posted an Undo without a token. It now
  sends the completion receipt's `commitSha`. No Worker source changed.
- **Queue gate suites** (R4, N2, G3-2 in `queue.gate.test.ts`) test the queue's generic dependency rules. With ADR-0013
  an Undo draft never reaches the send path behind a refused completion; it is dropped instead. So those suites now
  use a tokened Undo as the dependent, which keeps the generic rules guarded. Draft behaviour is covered separately in
  `queue.test.ts`.
- `commitsSince` counts commits in `C..X`. With desktop merge commits (the sync worker uses `merge-tree`), GitHub's
  compare also counts the merged-in side commits, so a busy week of desktop history reaches 250 sooner. That ends in
  `undo-expired`, which is the safe side.
- **Semantics change (per the ADR):** Undo no longer searches for the completion by trailer. An Undo whose completion
  receipt was lost cannot be sent, and ends in attention with advice to undo in Obsidian.

## Recommend

- Apply the same single-page bound to the other commands' dedupe if P3-A measurements show it is needed (ADR-0013
  "Consequences").
- The P3-A sizing note can now use 10 / 30 calls for Undo.
- `findOperation`'s trailer-key parameter is no longer used by Undo. Keep it until the other commands move too, then
  simplify.

## Verification

- `pnpm check` (lint + typecheck + tests, including `packages/e2e` on real Git): **green**, 37 files, 572 tests.
- Web e2e (`vite build` + Playwright): **26/26** on the pre-installed Chromium with the iPhone 15 profile. WebKit
  can't be downloaded in this sandbox; CI runs WebKit.
- **Guards broken once, each confirmed to fail its tests:**

  | # | Mutation | Caught by |
  |---|---|---|
  | G1 | token's Op trailer not checked | domain: right hash, other operation ID |
  | G2 | token's payload hash not checked | domain: A28 forged target |
  | G3 | token not an ancestor accepted | domain: not an ancestor, head holds same bytes |
  | G4 | own-op dedupe removed | domain: lost-response retry ⇒ already-applied |
  | G5 | second-Undo check removed | domain: second Undo refused |
  | G6 | `too-many` ignored | domain undo-expired; gate F2; GitHub budget |
  | G7 | exact inverse disabled | domain A1/R1 gate case |
  | G8 | replay verification skipped | domain: right trailers, other content |
  | G9 | 5 attempts instead of 3 | domain ≤ 3 attempts; GitHub head-moving test |
  | G10 | base tree not reused (GitHub) | GitHub budget (11 calls) |
  | G11 | GitHub page overflow ignored | GitHub undo-expired test |
  | C1 | draft sent without its token | queue drafts (3 tests) |
  | C2 | draft of a refused completion kept | queue: dropped locally |
  | C3 | receipt a draft needs evictable | queue: never evicted |

## Commit

Branch `agent/token-undo` (pushed). Final SHA in the last line of the session report.
