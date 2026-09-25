# Checkpoint — 2026-09-25 (Phase 1, services integrated)

**HEAD:** `main` (clean after this commit). **Tests:** lint + typecheck + 305 tests / 20 files green;
Playwright WebKit 7/7 green at `86ef426` (web unchanged since).

**Completed since last checkpoint:** command services hardened at the kernel seam (`checkNoteInput`,
`KernelInvariantError` ⇒ non-retryable refusal); seam tests covering A1, A3–A5, A7, A10–A14, A17, A26–A28, A30,
A38, capture golden (ADR-0010) and lost-response retries for every command; InMemoryStore CAS made atomic.

**Remaining in Phase 1:** `docs/plan.md` → Work in progress items 3–4.

**Branches/worktrees:** `agent/markdown-kernel`, `agent/frontend-shell` merged; worktrees kept until the Phase 1
review. Herdr workers `kernel` (`w3:p4`), `frontend` (`w3:p3`) idle.

**Risks:** `docs/plan.md` → Unresolved issues / risks.

**Memory event (2026-09-25 ~02:40):** Claude Code reaped the Lead's background waiter because system memory was
critically low (0.6 GB free of 15.4 GB). Not a review failure. The idle `kernel` pane (`w3:p4`, work merged) was
closed to relieve pressure. Still running: `review-opus` (`w3:p5`), Astra `codex exec` (`w3:p6`), Sol `codex exec`
(`w3:p7`). No automatic re-waiting was started.

**Exact next action:** check for `docs/reviews/phase-1-review-opus.md` and `docs/reviews/phase-1-review-astra.md`
(Astra/Sol progress: `astra-run.log`/`sol-run.log` in the Lead scratchpad, UTF-16). If a reviewer process died,
re-launch it from `docs/reviews/phase-1-review-brief.md` per `docs/plan.md` item 4 — only when memory allows.
Then reconcile into `docs/reviews/phase-1-reconciliation.md`; then review and merge `agent/ci` (brief C).
