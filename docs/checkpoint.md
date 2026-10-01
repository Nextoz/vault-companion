# Checkpoint — 2026-10-02 (SP4 + Mood M1 deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: SP4 prefetch #63 + Mood M1 #64** (main `36e8d03`, Worker `f5ea4843`, tag `sp4-36e8d03`, deployed overnight
  2026-10-02 00:30, verified 100 % + anonymous 302 to Access; **rollback `cae397cc`** = Weather). Mood M1 has no runtime
  effect yet (ADR-0036 *proposed*). Radar limit: a decision log older than 25 months ⇒ Radar refuses (design by ~2028-09).
- **Phone problem (owner, 2026-10-01):** app fails on the phone, works on PC; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).
- Codex Lead evidence: branch `archive/codex-lead-2026-10-01`. Parallel workers allowed by owner (2026-10-01).

## Next actions (in order)

Overnight rules in `.agent/overnight.md` (until 08:00): up to 3 parallel workers, GLM trial on the next ordinary slice,
CodeRabbit 3/hour, paste `.agent/check-<task>.md` into each PR under "Pre-handoff check".
1. **UI - Dark iOS refresh, slice 1 (Today pilot)** — read that section of the vault Ready Backlog (palette, two modes,
   five slices). Worker: **GLM-5.2 trial**. Attach a 390x844 WebKit screenshot to the PR and `.agent/screenshots/`.
2. In parallel (different files): **Mood M2** (high-risk, Pro): command `mood-checkin` on `Journal/Daily/YYYY-MM-DD.md`
   via `applyMoodCheckin`, create-from-template via `renderDailyNote`, op ID/CAS/trailers/dedupe, exact-inverse Undo,
   `docs/vault-contract.md` Journal section + §7 exception (ADR-0036). Then M3 Today card after the UI pilot lands.
3. SP3 show-last-copy (needs ADR); phone measurement of SP once the phone works.

## Owner items

- Describe the phone symptom. Deploys: `wrangler versions upload --tag/--message` then `versions deploy <id>@100% --yes`.
- Review ADR-0036 (Mood check-in choices: ISO `checkin_at`, prose values refused).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar (Remove/Undo, Keep pending).
- Confirm the 2026-09-30 amendments carried over: ADR-0018 wider Lead read scope; product-contract extension (Dashboard,
  Weather, Needs You, reviews, Apple Health intake per ADR-0033, now merged).

## Budget

DeepSeek: $9.99 available (read-only balance check 2026-10-01 21:13); check before the first Pro run.
Scaleway GLM-5.2: 1M declared free tokens, keep 100k margin; ~24k used (local accounting, not a provider invoice). CodeRabbit CLI: 3 reviews per rolling hour, usage billing inactive.
