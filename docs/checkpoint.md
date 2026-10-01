# Checkpoint — 2026-10-01 (Claude Lead takeover)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- `main` = deployed **Dashboard** (`f5047d5`, PR #53, Worker version `190e091c`). Also live since 2026-09-28: R1
  explainer (#45), B1/B2 + This Morning (#46), scout fixes (#49), read cache (#52). Owner phone checks pending.
- **PR #54 Research Radar** (`delivery/research-radar`, draft, +4.9k lines): CI green, CodeRabbit findings resolved.
  Adds a new vault write target ⇒ high-risk. Blocked only by the old "independent Pro review" rule.
- **PR #56 Weather** (`delivery/weather-w1`, stacked on Radar): CI green, CodeRabbit finding resolved. Clone
  `C:\Dev\vault-companion-clones\weather-delivery`; CodeRabbit CLI run 2026-10-01: 5 trivial findings, all skipped by Jev.
- Closed as superseded (owner, 2026-10-01): #50/#51 harness, #55 Jev policy, #57 CodeRabbit policy. Their useful
  parts are `tools/handoff-check.ps1` and `docs/orchestration.md`.
- The Codex Lead's 64 unpushed docs commits are on local branch `archive/codex-lead-2026-10-01` (evidence only).
  The held harness candidate stays in `C:\Dev\vault-companion-clones\harness-closeout` (not needed).

## Next actions (in order)

1. **Radar #54 — Lead's focused independent review** (owner decision 2026-10-01): read only the write path
   (`packages/domain/src/research-radar-command.ts`, `research-radar-format.ts`, the Worker route and the vault-contract
   change) against AGENTS.md non-negotiables 3–4 and ADR-0032. Write target: append-only
   `Research/Radar/Decisions/YYYY-MM.jsonl`; read bounds 25 months / 5,000 lines / 48 subrequests. Fix or record
   findings, then `pnpm check` + e2e once, mark ready, merge. Then `ACTION NEEDED:` deploy approval (new write target).
   Clone `C:\Dev\vault-companion-clones\radar-delivery`: **`origin` is a local clone, `github` is GitHub** — check
   remotes before pushing. Prior evidence and CodeRabbit dispositions: `.agent/resume/radar-*` in the main checkout;
   previous Lead's handover `.agent/resume/claude-lead-handoff-20261001.md` (read only the Radar/Weather sections;
   its pause, review floor, watcher and Jev-ledger rules are superseded by ADR-0035).
2. **Weather #56:** retarget to `main` after Radar merges, merge `main` in, `pnpm check` + e2e once, Lead diff read
   of the Weather-only delta (ordinary risk except the location permission change), merge, ask for deploy.
3. Then features from the Ready Backlog, owner order 2026-10-01: phone-facing items first (Mood check-in, SP speed,
   B3/B4). Harness v0 is not a priority: `handoff-check.ps1` replaces it.

## Owner items

- Phone acceptance: Dashboard, R1 explainer, This Morning panel.
- Confirm the 2026-09-30 amendments carried over: ADR-0018 wider Lead read scope; product-contract extension (Dashboard,
  Weather, Needs You, reviews, Apple Health intake per ADR-0033 — ADR-0033 arrives with PR #54/#56).

## Budget

DeepSeek: $9.99 available (read-only balance check 2026-10-01 21:13); check before the first Pro run.
Scaleway GLM-5.2: 1M declared free tokens, keep 100k margin; ~24k used (local accounting, not a provider invoice). CodeRabbit CLI: 3 reviews per rolling hour, usage billing inactive.
