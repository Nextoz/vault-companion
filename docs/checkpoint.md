# Checkpoint — 2026-10-02 03:45 (UI refresh slice 4 merged, not deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Merged, NOT deployed: UI refresh slices 1 #67, 2 #69, 3 #71, 4 #73** (main `ab7d21c`). Slice 1: dark iOS tokens + Today
  pilot (ADR-0037). Slice 2: Scouts board — two-column stat tiles (health dot, big findings number in health colour,
  last run, decorative sparkline); scout/Insights colours on tokens. Slice 3: Dashboard + Weather board panels (SVG,
  Jev chose SVG over uPlot ⇒ no dep/ADR), indigo/orange gradient lines; fixed Weather lines plotting raw values as
  pixel y. Slice 4: Training + Progress/History in iPhone mode, SVG `BarChart` + pure `week-chart.ts`: cyan
  "Sessions per week" (8 wk) and green "Tasks done this week" (Jev: fits ADR-0021, 0.93). Screenshots: `.agent/screenshots/ui1-today-*`, `ui2-scouts-390x844.png`, `ui3-dashboard-*`, `ui4-*`. Production deploys are denied by the auto-mode classifier — owner deploys.
- **Live: SP4 + Mood M1** (Worker `f5ea4843` = rollback target for the next deploy; older rollback `cae397cc`).
- **Worker launches:** codex (Flash/Pro) launches are denied by the classifier ([Create Unsafe Agents]); GLM trial
  FAILED (two silent exits). Until the owner allows codex launches, the Lead implements small ordinary slices itself.
- **Phone problem (owner, 2026-10-01):** app fails on the phone; symptom unknown. Blocks phone acceptance.
- Overnight mode until 2026-10-02 08:00 (`.agent/overnight.md`); decisions in `.agent/overnight-decisions.md`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (reverts #52 cache expectations, origin unknown).

## Next actions (in order)

1. **Mood M2** (high-risk, Pro): brief ready in `C:/Dev/vault-companion-clones/mood-m2/.agent/brief.md` (base
   `ad1a9bb`; rebase/re-clone onto main first). Blocked on a codex launch (owner) — do not self-implement.
2. **UI refresh slice 5** — Notes, Active Work, Radar, dialogs/sheets in the tokens; remove leftover old colours/CSS.
   Ordinary; Lead may implement. Possibly split (5a screens, 5b CSS removal). 390x844 WebKit screenshot via a
   temporary spec (`pnpm build` first in a fresh clone; `tsc -b`, not `pnpm -r exec tsc`, before build).
3. M3 Today mood card after M2; SP3.

## Owner items

- Deploy main `ab7d21c` (#67 + #69 + #71 + #73): from `apps/worker` after a clean `pnpm build`: `wrangler versions upload
  --tag ui4-ab7d21c --message "UI refresh slices 1-4"` then `wrangler versions deploy <id>@100% --yes`; rollback `f5ea4843`.
- Allow codex worker launches (Bash permission rule) or launch Mood M2 yourself.
- Describe the phone symptom. Review ADR-0036 (Mood) and ADR-0037 (UI tokens).
- Phone acceptance (after the phone fix): Dashboard, R1 explainer, This Morning, Radar, the new dark Today + Scouts + Dashboard/Weather + Training + Progress.

## Budget

DeepSeek: $9.80 (owner-status 03:00). GLM-5.2: ~24k/900k local estimate.
CodeRabbit CLI: 3 reviews used (~02:30, ~02:57, ~03:33).
