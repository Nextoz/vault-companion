# ADR-0015 — Bounded write budget (every command fits Workers Free)

**Status:** accepted (Lead, 2026-09-26; the owner chose Workers Free). Review: `docs/reviews/phase-2-review-astra.md`
P2-A1 (and P2-A4 for the Done-today overlay).

**Context.** Workers Free allows 50 external subrequests per invocation. ADR-0013 bounded Undo; CompleteTask,
CaptureTask and CaptureNote still paged their dedupe window (`baseRevision..X`, up to 20 compare pages) over up to 5
head-moved attempts. Astra measured 51 calls for a two-page window with 4 lost races and a cold token, 141 at 20 pages,
and 56 for CaptureNote with an absent `Inbox/` even with one page.

**Decision.**
1. **One compare page for every dedupe.** Every write command settles "already applied?" with one single-page listing
   of `baseRevision..X` (≤ 250 commits; `commitsSince`, the same primitive as ADR-0013). A base that is not an ancestor
   of X, or more than one page, ⇒ `dedupe-unknown` "this may already be applied — check Obsidian". Never paging, never
   a guess, never a write.
2. **`MAX_ATTEMPTS = 3` for every command** (head-moved re-plans).
3. **The client moves a never-sent item's base forward.** Immediately before an item's *first* send, the queue sets its
   `baseRevision` to the newest task read's revision. No commit can contain an operation that was never sent, so this
   is safe, and it keeps the window small however long the item waited. It is rewritten once and persisted with the
   claim, so every later attempt (and any other tab) resends identical bytes. An item that may have been sent keeps
   its base.
4. **CaptureNote with an absent `Inbox/`.** The GitHub adapter keeps directory listings per (commit, directory) —
   commits are immutable — so planning's listing also serves the write precondition on the same commit. The root
   listing's tree SHA and every commit seen in a compare page provide the base tree without a separate commit read.
5. **Done today (P2-A4).** A completion overlay appears in Done today only if the action's date in the read's time zone
   (`occurredAt`, Europe/Copenhagen) equals the read's `today` — the same rule that dates its `✅` on the server. An
   older one stays off the list (the server will leave it off too) and remains visible in Actions.

**Budget (measured, `packages/github/src/write-budget.test.ts`, worst case: full 250-commit page, head moved on every
attempt, 3 attempts, cold installation token; +1 Access JWKS).**

| Command | Store requests per attempt | 3 lost races + cold token | + JWKS | Workers Free |
|---|---|---|---|---|
| CompleteTask | 8 (ref, compare, task list, precondition listing, blob, tree, commit, ref) | 25 | 26 | ≤ 50 |
| CaptureTask | 8 | 25 | 26 | ≤ 50 |
| CaptureNote, Inbox present | 7 (the listing is also the precondition) | 22 | 23 | ≤ 50 |
| CaptureNote, Inbox absent | 8 (Inbox 404 + root listing) | 25 | 26 | ≤ 50 |
| any, already applied (lost response) | 8 | — | — | ≤ 50 |
| UndoCompleteTask (ADR-0013) | ≤ 10 | 31 | 32 | ≤ 50 |
| task read (review O1) | ≤ 4 | 5 | 6 | ≤ 50 |

**Consequences.**
- A command that applied, lost its response, and is retried after more than 250 further commits answers
  `dedupe-unknown` (not applied twice; the owner checks in Obsidian). With (3) this needs a burst of > 250 commits
  between the first send and a retry, not merely a long wait before the first send.
- The store port's paged `findOperation` is no longer used by any command; it stays until removed separately.
- Client retries remain unbounded in count (backoff to 60 s); the hourly GitHub budget is a Phase 3 sizing item.
