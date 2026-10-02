# Checkpoint — 2026-10-02 (B5+B6)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live before B5+B6: `a984b3b5`** (B7, main 0665a67). B5+B6 is deployed right after its merge; the new version ID
  and rollback target are in `.agent/decisions.md`.
- **B7** live: `renderDailyNote` formats `{{date:<fmt>}}` (YYYY MMMM MM dddd DD D, separators ` ,./-`); else refusal.
- **B5+B6** (worker, handoff-check clean; pnpm check 1819 + e2e 102): a newer prefetch key aborts the running warm
  sequence (one sequence at a time); `ScoutStatus.runStatus`/`aiHealth` turn an unknown enum into `null` instead of
  dropping the whole scout record.
- **Open worker candidate (base 63b9dc0):** `clones/ux1` (bottom tab bar Today · Scouts · Notes · Log · More,
  `e2e/nav.ts` `goTo`) — handoff done, needs handoff-check, rebase on main, then Lead runs e2e (worker sandbox has no
  browser).
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. Land ux1 (handoff-check + rebase + e2e + PR).
2. Owner bug order (2026-10-02): **B8 → B11 → B12 → B9** (Ready Backlog bug table), before any new UX slice.
3. Then UX2–UX5 → AB AI budget card → NY Needs You + Morning Review → SP phone measurement (re-read the backlog).

## Owner items

- Phone: Today → mood check-in on a day with no journal note yet → saves (B7).
- Phone: Dashboard → Health board; Report button → test Bug → Undo from Actions.
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.

## Budget

DeepSeek $8.51. GLM ~140k/900k.
