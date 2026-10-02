# Checkpoint — 2026-10-02 03:05 (UI refresh slice 2 merged, not deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Merged, NOT deployed: UI refresh slices 1 #67 and 2 #69** (main `3be1d8d`). Slice 1: dark iOS tokens + Today
  pilot (ADR-0037). Slice 2: Scouts board — two-column stat tiles (health dot, big findings number in health colour,
  last run, decorative sparkline); scout/Insights colours on tokens. Screenshots: `.agent/screenshots/ui1-today-*`,
  `ui2-scouts-390x844.png`. Production deploys are denied by the auto-mode classifier — owner deploys.
- **Live: SP4 + Mood M1** (Worker `f5ea4843` = rollback target for the next deploy; older rollback `cae397cc`).
- **Worker launches:** codex (Flash/Pro) launches are denied by the classifier ([Create Unsafe Agents]); GLM trial
  FAILED (two silent exits). Until the owner allows codex launches, the Lead implements small ordinary slices itself.
- **Phone problem (owner, 2026-10-01):** app fails on the phone; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).

## Next actions (in order)

1. **Mood M2** (high-risk, Pro): brief ready in `C:/Dev/vault-companion-clones/mood-m2/.agent/brief.md` (base
   `ad1a9bb`; rebase/re-clone onto main first). Blocked on a codex launch (owner) — do not self-implement.
2. **UI refresh slice 3 — Dashboard + Weather board** (stat tiles, time-series panels). Backlog suggests uPlot: a new
   dependency ⇒ ADR (or simple SVG like the Scouts sparkline, which needs no ADR). Ordinary; Lead may implement.
   390x844 WebKit screenshot via a temporary spec (`page.screenshot`, needs `pnpm build` first — e2e uses preview).
3. Slices 4 (Training + History), 5 (remaining screens, old CSS removal); M3 Today mood card after M2; SP3.

## Owner items

- Deploy main `3be1d8d` (#67 + #69): from `apps/worker` after a clean `pnpm build`: `wrangler versions upload --tag
  ui2-3be1d8d --message "UI refresh slices 1-2"` then `wrangler versions deploy <id>@100% --yes`; rollback `f5ea4843`.
- Allow codex worker launches (Bash permission rule) or launch Mood M2 yourself.
- Describe the phone symptom. Review ADR-0036 (Mood) and ADR-0037 (UI tokens).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar, the new dark Today + Scouts.

## Budget

DeepSeek: $9.80 (owner-status 03:00). GLM-5.2: ~24k/900k local estimate.
CodeRabbit CLI: 2 reviews used (~02:30, ~02:57).
