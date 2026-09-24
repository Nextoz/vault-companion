# Checkpoint — 2026-09-24 22:35 (Phase 1, mid-integration)

**HEAD:** `main` @ `9aafad4` (clean). **Tests:** lint + typecheck + 284 unit/integration tests green;
Playwright WebKit 7/7 green at `86ef426`.

**Completed this session:** Phase 0 (discovery, spikes, contracts, ADR-0001…0010, review + reconciliation);
Phase 1 interfaces; domain executor (F1-safe, mutation-checked); LocalGitStore + GitHubContentsStore + shared
store contract; G1 sandbox probe; worker HTTP security layer; command services (untested against real kernel);
kernel (K) and PWA (F) delegated, reviewed, merged.

**Remaining in Phase 1:** see `docs/plan.md` → "Work in progress (exact next actions)" items 1–4.

**Branches/worktrees:** `agent/markdown-kernel` (`71d8654`, merged) and `agent/frontend-shell` (`182dfca`, merged),
worktrees under `C:\Dev\vault-companion-worktrees\`. Herdr workers `kernel` (`w3:p4`) and `frontend` (`w3:p3`) idle,
kept for possible review follow-ups.

**Risks:** see `docs/plan.md` → "Unresolved issues / risks".

**Exact next action:** in `packages/domain/src/commands.ts`, call `md.checkNoteInput` before `renderNote` and map
`KernelInvariantError`; then write `packages/domain/src/commands.test.ts` (plan item 2).
