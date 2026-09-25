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

**Phase 1 gate: PASSED WITH FIXES** (run 3: Opus + Astra both PASS WITH FIXES, no Critical/High). Reconciliation:
`docs/reviews/phase-1-reconciliation.md` ("Gate run 3"). App repo now has a private remote: `Nextoz/vault-companion`
(created 2026-09-25 with owner approval; contains no vault content).

| Stream | Owner | Status |
|---|---|---|
| Lead gate-3 items G3-3, F1, F2 | Lead | **done** `a3e442e`, `593d2f6` (443 tests, mutants killed) |
| F4 queue gate-3 (G3-1 watermark, G3-2 atomic retry, F3 App wiring) | Opus 5.5 worker `f4` (retired) | **merged**, 454 tests, e2e 8/8 |
| D1 spec drift (F6) | Codex **Astra low**, pane `w3:pG`, branch `agent/spec-drift` (local worktree), log `d1-run.log` in Lead scratchpad | in flight |
| C CI + `pnpm ci:local` | **Claude Code Cloud** session `session_01WxbFmRJdtnNWyYPcqLkmvt`, branch `agent/ci` (pushed by the cloud) | in flight (first cloud trial) |
| P2-A Phase 2 e2e harness (real Git, Node server, desktop clone, scenarios) | **Claude Code Cloud** session `session_01FyLWeGWnPruL9dXefaVGf3`, branch `agent/e2e-harness`, brief `docs/briefs/P2A-e2e-harness.md` | in flight |
| F4-sizing (server deadline, concurrent `known=`) | — | Phase 3 sizing |

Next: review + merge F4, D1, C (cloud: `git fetch`, review `origin/agent/ci`, verify locally, merge); then Phase 2
(disposable end-to-end) — to be decomposed into Cloud briefs (repo-contained) + Astra-low tasks.

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
