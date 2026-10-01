# Checkpoint — 2026-10-02 (SP4 + Mood M1 merged, deploy pending owner)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: Weather** (Worker `cae397cc`, tag `weather-e43f9d7`; rollback `f1e8b609` = Radar). Radar known limit: once a
  decision log is older than 25 months Radar refuses reads/writes — needs a rollover design before ~2028-09.
- **Merged, not live:** SP4 prefetch #63 (Notes/Progress/Training warm the per-commit read cache after a task read) and
  Mood M1 #64 (pure frontmatter splice, ADR-0036 *proposed*; no runtime effect). Both: `pnpm check` + e2e 91, CI green.
  Version uploaded with tag `sp4-36e8d03` (no traffic). The deploy was denied by Claude Code auto mode: owner deploys.
- **Phone problem (owner, 2026-10-01):** app fails on the phone, works on PC; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).
- Codex Lead evidence: branch `archive/codex-lead-2026-10-01`. Parallel workers allowed by owner (2026-10-01).

## Next actions (in order)

1. **Mood M2** (high-risk, new write target): Worker command `mood-checkin` on `Journal/Daily/YYYY-MM-DD.md` using
   `applyMoodCheckin`, create-from-template via `renderDailyNote`, op ID/CAS/trailers/dedupe, exact-inverse Undo;
   update `docs/vault-contract.md` (Journal section, §7 exception) per ADR-0036. Then M3 Today card (Layout C).
2. SP3 show-last-copy (needs ADR). Phone measurement of SP when the phone works.

## Owner items

- Deploy `36e8d03` (SP4 + M1): `cd apps/worker; pnpm exec wrangler versions list` → id tagged `sp4-36e8d03` →
  `pnpm exec wrangler versions deploy <id>@100% --yes`; rollback `wrangler rollback cae397cc`. Describe the phone symptom.
- Review ADR-0036 (Mood check-in choices: ISO `checkin_at`, prose values refused).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar (Remove/Undo, Keep pending).
- Confirm the 2026-09-30 amendments carried over: ADR-0018 wider Lead read scope; product-contract extension (Dashboard,
  Weather, Needs You, reviews, Apple Health intake per ADR-0033, now merged).

## Budget

DeepSeek: $9.99 available (read-only balance check 2026-10-01 21:13); check before the first Pro run.
Scaleway GLM-5.2: 1M declared free tokens, keep 100k margin; ~24k used (local accounting, not a provider invoice). CodeRabbit CLI: 3 reviews per rolling hour, usage billing inactive.
