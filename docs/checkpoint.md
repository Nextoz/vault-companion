# Checkpoint — 2026-10-01 (Radar deployed, Weather #56 merged)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Deployed: Radar** (`main` `292df67`, Worker version `f1e8b609`, tag `radar-292df67`, owner-approved 2026-10-01;
  rollback baseline Dashboard `190e091c`). Includes Dashboard (#53), R1 (#45), B1/B2 + This Morning (#46), scouts (#49),
  read cache (#52), Radar (#54; Lead review in `docs/reviews/RR1-integration.md`).
  Known, fail-closed: once any Radar decision log is older than 25 months, Radar refuses all reads and writes — needs a
  rollover/archive design before ~2028-09.
- **Weather #56 merged** (`e43f9d7`, not deployed). Lead diff read: location rounded ~1 km before provider/cache, POST
  body only, origin/account guards, `geolocation=(self)`. `pnpm check` 1695 + e2e 91 passed, CI green.
- **Phone problem (owner, 2026-10-01):** app does not work on the phone but works in the PC browser; symptom unknown.
  Server side checked: site up, unauthenticated requests 302 to Cloudflare Access, the client maps expired Access to
  signed-out. Needs the owner's symptom before more work. Blocks all phone acceptance.
- Closed as superseded (owner, 2026-10-01): #50/#51 harness, #55 Jev policy, #57 CodeRabbit policy. Their useful
  parts are `tools/handoff-check.ps1` and `docs/orchestration.md`.
- The Codex Lead's 64 unpushed docs commits are on local branch `archive/codex-lead-2026-10-01` (evidence only).
  The held harness candidate stays in `C:\Dev\vault-companion-clones\harness-closeout` (not needed).

## Next actions (in order)

1. Features from the Ready Backlog, owner order 2026-10-01: phone-facing items first (Mood check-in, SP speed,
   B3/B4). Harness v0 is not a priority. Main checkout has an uncommitted `apps/worker/test/sp-read-latency.test.ts`
   change of unknown origin (not the Lead's) — check before SP speed work.

## Owner items

- Approve Weather deploy; describe the phone symptom.
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar (Remove/Undo, Keep pending).
- Confirm the 2026-09-30 amendments carried over: ADR-0018 wider Lead read scope; product-contract extension (Dashboard,
  Weather, Needs You, reviews, Apple Health intake per ADR-0033, now merged).

## Budget

DeepSeek: $9.99 available (read-only balance check 2026-10-01 21:13); check before the first Pro run.
Scaleway GLM-5.2: 1M declared free tokens, keep 100k margin; ~24k used (local accounting, not a provider invoice). CodeRabbit CLI: 3 reviews per rolling hour, usage billing inactive.
