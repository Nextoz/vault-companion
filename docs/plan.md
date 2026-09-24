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
| K Markdown kernel + fixtures | worker `kernel` (Opus 5.5, pane `w3:p4`, branch `agent/markdown-kernel` @ `71d8654`) | **merged** (`9aafad4`), 176 tests, report `docs/reviews/K-report.md` |
| F PWA shell + queue | worker `frontend` (Opus 5.5, pane `w3:p3`, branch `agent/frontend-shell` @ `182dfca`) | **merged** (`86ef426`), 29 unit + 7 WebKit e2e, report `docs/reviews/F-report.md` |
| B domain: time/path policy, JCS hash, pinned-commit executor, InMemoryStore | Lead | done, F1 guard mutation-checked |
| B stores: LocalGitStore (real git), GitHubContentsStore, App token source, shared store contract | Lead | done; GitHub semantics verified on sandbox (G1) |
| B worker HTTP: Access JWT, origin/CSRF, headers, allowlisted logger | Lead | done (29 tests) |
| B command services (`packages/domain/src/commands.ts`) + read model | Lead | code done; **integration with real kernel in progress** |
| CI (GitHub Actions) | Codex GPT-6 Sol (routing policy) | not started |

Test status at `9aafad4`: `pnpm lint`, `pnpm typecheck`, `pnpm test` green — 284 tests / 19 files.
Playwright WebKit e2e (`pnpm --filter @vault-companion/web e2e`) green at `86ef426`.

### Work in progress (exact next actions)

1. `packages/domain/src/commands.ts`: call `md.checkNoteInput` before `renderNote` (renderNote throws on bad
   input); map `KernelInvariantError` to a non-retryable refusal instead of a 500.
2. `packages/domain/src/commands.test.ts`: command services against InMemoryStore + real kernel + test-vault
   fixtures — lost response on Complete (A10), double submit (A11), op-ID reuse (A12), safe replay after another
   task changed (A13), same-task conflict (A14), F2 twin (A26), Undo exact + after unrelated edit + forged target
   (A3/A4/A28), capture top of Open (ADR-0010), note collision casefold (A30), clock skew (A17), backdated flag,
   A38 midnight upload.
3. Wire `apps/worker` entry: production composition (GitHubContentsStore + Access verifier from env bindings)
   and a Node dev/e2e composition (LocalGitStore) — needed for Phase 2.
4. Phase 1 gate: fresh-context **Opus** adversarial review + **GPT-6 Astra** cross-model review of kernel and
   retry/dedupe; reconcile; then CI via GPT-6 Sol.

### Unresolved issues / risks

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
