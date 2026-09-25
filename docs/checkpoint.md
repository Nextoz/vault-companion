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

**Phase 1 gate (2026-09-25):** failed; reconciled (`docs/reviews/phase-1-reconciliation.md`), ADR-0011 head-CAS
decided with real probe evidence. K2 (`w3:p8`) and F2 (`w3:p9`) fix workers running; panes w3:p4–p7 closed.

**Gate rerun:** Astra BLOCK (1 Critical: create could replace a file/directory), Opus PASS WITH FIXES. Lead fixes done
(`a9800c2`, 424 tests). F3 (queue/view) in flight in pane `w3:pC`, branch `agent/queue-rerun-fixes`.

**Phase 1 gate passed with fixes** (run 3). Lead fixes committed (`593d2f6`, 443 tests). Remote `Nextoz/vault-companion` (private)
exists; `main` pushed. Claude tokens are running low: implementation is routed to Cloud and Astra-low.

**In flight:** F4 (Opus, pane `w3:pF`, local branch `agent/queue-gate3`); D1 (Astra low, pane `w3:pG`, local branch
`agent/spec-drift`); C (Cloud `session_01WxbFmRJdtnNWyYPcqLkmvt`, branch `agent/ci` on origin).

**Exact next action:** for each finished stream: read its report (F4: `docs/briefs/F4-report.md`; D1: `D1 DONE` line in
`d1-run.log`; C: `git fetch` then `docs/briefs/C-report.md` on `origin/agent/ci`), review the diff, run `pnpm check`
(+ web e2e for F4), merge, push `main`. Then decompose Phase 2 into Cloud briefs.
