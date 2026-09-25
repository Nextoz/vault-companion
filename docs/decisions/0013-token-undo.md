# ADR-0013 — Token-based Undo (no history paging)

**Status:** accepted (Lead, 2026-09-25, on the owner's request before any paid Workers plan).

**Context.** Undo currently runs three paged compare scans per attempt (`packages/domain/src/commands.ts`): its own
dedupe over `undo.baseRevision..X`, a search for the completion over `target.baseRevision..X`, and an "already undone"
search over `C..X`. P3-A sized this at ≈ 92 subrequests shallow and ≈ 377 worst case per Undo (× attempts), above the
Workers Free limit (50) and a real share of GitHub's ~5,000 requests/hour installation limit.

**Decision.** The completion's commit SHA `C` travels with the Undo as a token.
- Contract: `UndoCompleteTask.payload` gains `targetCommit` (40-hex), taken from the completion's receipt. The client
  only offers Undo for completions it holds a receipt for; an Undo queued behind an unacknowledged completion gets
  `targetCommit` filled in once, before its first send, and is persisted so retries resend identical bytes. An Undo of
  a completion that ends refused is discarded locally (existing behaviour).
- Server, per attempt (X = head): read commit `C` and verify its `Vault-Companion-Op` trailer equals the target's
  operation ID and its payload hash matches the target envelope (forged or wrong tokens are refused, never trusted);
  one **single-page** compare `C...X` (≤ 250 commits) answers three questions at once — `C` is an ancestor of `X`, the
  Undo's own operation ID is already applied (dedupe ⇒ `already-applied`), another Undo of `C` exists (⇒ refused). More
  than one page since `C` ⇒ typed refusal `refused:undo-expired` ("too much changed since; undo in Obsidian"); no
  paging, no guessing. Then the existing exact-bytes / semantic inverse and a head-CAS write.
- Undo uses at most **3 attempts** (head-moved retries).

**Budget.** Per attempt ≈ 10 GitHub calls (ref, commit `C`, compare, 2–3 file reads, blob/tree/commit/ref write);
typical Undo ≈ 10, worst ≈ 30 (3 attempts), no paging. Fits Workers Free (50) and keeps GitHub usage negligible.

**Why the token is safe.** Desktop sync never rewrites lines (it commits, merges via `merge-tree`, never force-pushes —
inspected 2026-09-25); if the owner edits the completed line, Undo already refuses as a conflict (A5). The token is
verified against Git, so a wrong or stale token can only produce a refusal.

**Consequences.** Contract + domain + store + client change, with tests: forged token, token not on branch, own-Undo
lost-response retry (`already-applied`), double Undo, `undo-expired` at > 250 commits, exact-bytes and semantic
inverse, and a call-count assertion (≤ 10 per attempt). Other commands keep ADR-0005 paging for now; the same
single-page bound can be applied to them later if measurements warrant it.
