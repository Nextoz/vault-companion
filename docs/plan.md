# Current plan

Lead: Claude Opus 5.5 (Herdr pane `w3:p1`). Orchestration, model routing and **resume protocol**:
`docs/orchestration.md`. Latest checkpoint: `docs/checkpoint.md`. Updated: 2026-09-24 22:35.

## Phase 0 — Discovery and real integration spike — DONE

Findings `docs/discovery/phase-0-findings.md`; spike `tools/spikes/git-sync-spike.sh`; ADR-0001…0010;
fresh-context Opus review PASS WITH FIXES, all 24 findings reconciled (`docs/reviews/phase-0-reconciliation.md`).
Inherited, unverified: the Codex-updated desktop sync worker (absent from snapshot) — verify at canary.

## Phase 1 — Minimal safe kernel and authenticated phone shell — IN PROGRESS

| Stream | Owner | Status |
|---|---|---|
| Stable interfaces (contracts, VaultStore port, kernel API) | Lead | done |
| K Markdown kernel + fixtures | worker `kernel` (Opus 5.5, pane closed 2026-09-25 for memory; branch `agent/markdown-kernel` @ `71d8654`) | **merged** (`9aafad4`), 176 tests, report `docs/reviews/K-report.md` |
| F PWA shell + queue | worker `frontend` (Opus 5.5, pane `w3:p3`, branch `agent/frontend-shell` @ `182dfca`) | **merged** (`86ef426`), 29 unit + 7 WebKit e2e, report `docs/reviews/F-report.md` |
| B domain: time/path policy, JCS hash, pinned-commit executor, InMemoryStore | Lead | done, F1 guard mutation-checked |
| B stores: LocalGitStore (real git), GitHubContentsStore, App token source, shared store contract | Lead | done; GitHub semantics verified on sandbox (G1) |
| B worker HTTP: Access JWT, origin/CSRF, headers, allowlisted logger | Lead | done (29 tests) |
| B command services (`packages/domain/src/commands.ts`) + read model | Lead | done; seam-tested against real kernel + goldens |
| C CI (GitHub Actions + `pnpm ci:local`) | Codex **GPT-6 Sol** via `codex exec` (pane `w3:p7`, branch `agent/ci`, worktree `…-worktrees/ci`, log `sol-run.log` in Lead scratchpad) | **in flight** — brief `docs/briefs/C-ci.md`; runs on GitHub only once the app repo has a remote (owner action) |

Test status: `pnpm lint`, `pnpm typecheck`, `pnpm test` green — 305 tests / 20 files.
Playwright WebKit e2e (`pnpm --filter @vault-companion/web e2e`) green at `86ef426`.

### Work in progress (exact next actions)

**Phase 1 gate:** run 1 FAILED (24 findings, all fixed, `fea97cc`). Rerun: Astra BLOCK (1 Critical), Opus PASS WITH
FIXES — new findings reconciled in `docs/reviews/phase-1-reconciliation.md` ("Rerun" table).

| Stream | Owner | Status |
|---|---|---|
| Rerun Lead items (create/update precondition — the Critical; fail-closed listing; stale-Undo trailer; truncated listing refusal; console + onError tests; ADR-0011 precision) | Lead | **done** `a9800c2`, 424 tests, all guards mutation-checked |
| F3 queue/view rerun fixes (Astra N2, N3; Opus N5) | Opus 5.5 worker `f3`, pane `w3:pC`, branch `agent/queue-rerun-fixes`, brief `docs/briefs/F3-queue-rerun-fixes.md` | in flight |

Next: merge F3 → full check + WebKit e2e → **gate run 3** (fresh Opus + Astra; brief + rerun addendum; report names
`phase-1-rereview2-*.md`). CI blocked (GPT-6 Sol unavailable on owner's Codex account; owner decision pending).

### Unresolved issues / risks

- Phase 3 sizing: an Undo can make two paged dedupes per attempt × 5 attempts; check the Workers subrequest limit
  of the chosen plan before deploy (rerun Opus note).
- Leftover empty directories `C:\c\Dev\vault-companion-worktrees` from a path-conversion mistake — owner may delete.

- R7 residue (Low, deferred): semantic Undo leaves a blank line in Done when Done has other non-blank content
  (K2 report note 1; needs a vault-contract §4.2 change).

- Service-worker offline shell not e2e-tested (F-report open point 1) → real-phone checklist.
- Recent receipts are memory-only in the PWA (F-report 4): F10 overlay lost on reload.
- InMemoryStore does not model GitHub's branch ref-race 409 (G1 P12); covered by adapter mapping only.
- Worker pane cleanup: keep `kernel`/`frontend` panes until the Phase 1 review, then close panes and remove
  worktrees (branches are fully merged).

## Open owner decisions

| # | Decision | Default in force | Needed by |
|---|---|---|---|
| D1 | Today definition | due/scheduled/start ≤ today or 🔺/⏫; overdue as own group | Phase 4 (non-blocking) |
| D2 | Linked-note allowlist | `Projects/`, `Tasks/`, `Inbox/` only | Phase 4 (non-blocking) |
| D3 | Task IDs (ADR-0003) | no `🆔` writes in first release | non-blocking |
| D4 | App task-capture anchor | **Decided: top of Open** (ADR-0010) | done |

## Human gates

- G1 Private sandbox `Nextoz/vault-companion-sandbox` — **approved, created, kept**; probe evidence
  `docs/discovery/github-api-probe-2026-09-24.md`.
- G2 GitHub App, Cloudflare account/Access/Worker, `main` ruleset (credentials, external services) — Phase 3.
- G3 First live vault write (canary) — end of Phase 3.
