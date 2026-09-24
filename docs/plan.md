# Current plan

Lead: Claude Opus 5.5 (Herdr pane `w3:p1`). Orchestration and model routing: `docs/orchestration.md`.
Updated: 2026-09-24.

## Phase 0 — Discovery and real integration spike — DONE

Findings `docs/discovery/phase-0-findings.md`; spike `tools/spikes/git-sync-spike.sh`; contracts, ADR-0001…0009;
fresh-context Opus review PASS WITH FIXES (`docs/reviews/phase-0-architecture-review.md`), all 24 findings
reconciled (`docs/reviews/phase-0-reconciliation.md`).

Inherited, unverified: the Codex-updated desktop sync worker and its 17 passing cases (absent from snapshot).

## Phase 1 — Minimal safe kernel and authenticated phone shell — IN PROGRESS

Lead-owned stable interfaces (done first): `packages/contracts`, `VaultStore` port (`packages/domain/src/store.ts`),
kernel API (`packages/vault-markdown/src/api.ts`).

| Stream | Owner | Brief | Status |
|---|---|---|---|
| K Markdown kernel + fixtures | Herdr worker `kernel` (Opus 5.5), branch `agent/markdown-kernel` | `docs/briefs/K-markdown-kernel.md` | to dispatch |
| F PWA shell + queue | Herdr worker `frontend` (Opus 5.5), branch `agent/frontend-shell` | `docs/briefs/F-frontend-shell.md` | to dispatch |
| B Domain handlers, InMemoryStore, LocalGitStore, GitHubContentsStore, worker HTTP | Lead on `main` | this plan | time + path policy done (31 tests) |
| CI (GitHub Actions: lint, typecheck, test, audit, gitleaks) | Codex **GPT-6 Sol** (routing policy) | to write | after K/F merge |

Phase 1 gate: A1–A40 that apply at unit/HTTP level pass; CI green; fresh-context **Opus** adversarial review
plus a **GPT-6 Astra** cross-model review of kernel + retry/dedupe diffs; findings reconciled.

## Open owner decisions

| # | Decision | Default in force | Needed by |
|---|---|---|---|
| D1 | Today definition | due/scheduled/start ≤ today or 🔺/⏫; overdue as own group | Phase 4 (non-blocking) |
| D2 | Linked-note allowlist | `Projects/`, `Tasks/`, `Inbox/` only | Phase 4 (non-blocking) |
| D3 | Task IDs (ADR-0003) | no `🆔` writes in first release | non-blocking |
| D4 | App task-capture anchor vs QuickAdd end-of-Open (most common textual conflict, spike S5b) | end of Open (same as QuickAdd) | **before Phase 2** |

## Human gates

- **G1** Disposable private GitHub repo for adapter probing (external account action) — **requested now**
  (review F15); needed before the GitHub store contract freezes (late Phase 1).
- G2 GitHub App, Cloudflare account/Access/Worker, `main` ruleset (credentials, external services) — Phase 3.
- G3 First live vault write (canary) — end of Phase 3.
