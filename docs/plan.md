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

**Phase 1 gate: first run FAILED → all 24 findings fixed and integrated** (`fea97cc`; 408 tests, WebKit e2e 8/8).
Reconciliation + results: `docs/reviews/phase-1-reconciliation.md`.

**In flight — gate rerun** (brief + rerun addendum `docs/reviews/phase-1-review-brief.md`):
Opus 5.5 `rereview-opus` (pane `w3:pA`) → `docs/reviews/phase-1-rereview-opus.md`; GPT-6 Astra via `codex exec`
(pane `w3:pB`, log `astra-rerun.log` in the Lead scratchpad, UTF-16) → `docs/reviews/phase-1-rereview-astra.md`.

Next: reconcile rerun findings; if both PASS (or only Low findings remain), close Phase 1 and start Phase 2
(disposable end-to-end: Node harness over LocalGitStore + desktop clone + worker-equivalent sync; see roadmap).
CI: blocked — GPT-6 Sol unavailable on the owner's Codex account; owner to choose substitute or defer.

### Unresolved issues / risks

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
