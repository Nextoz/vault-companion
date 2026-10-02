# Checkpoint — 2026-10-02 (B7 hotfix)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live before B7: `a512378b`** (FB1+FB2, main c3fe2c7). B7 is deployed right after its merge; the new version ID and
  rollback target are in `.agent/decisions.md`.
- **B7** (owner, live bug: every mood check-in save failed when the day's note did not exist yet): the real Daily
  Journal Template also uses `{{date:dddd, D MMMM YYYY}}`. `renderDailyNote` now formats `{{date:<fmt>}}` with the
  tokens YYYY MMMM MM dddd DD D and separators ` ,./-` (English names, weekday in UTC from the Copenhagen calendar
  date); any other token or placeholder is still refused. Lead fix (~25 lines), Jev: ordinary risk.
- **Open worker candidates (base 63b9dc0):** `clones/bugs-b5b6` (B5 prefetch abort + B6 scout per-field `.catch(null)`)
  — handoff-check CLEAN, needs Lead diff read + rebase on main + check/e2e + PR. `clones/ux1` (bottom tab bar Today ·
  Scouts · Notes · Log · More, `e2e/nav.ts` `goTo`) — handoff done, needs handoff-check, then Lead runs e2e (worker
  sandbox has no browser).
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. Land bugs-b5b6 (PR), then ux1 (handoff-check + e2e + PR).
2. Owner bug order (2026-10-02): **B8 → B11 → B12 → B9** (Ready Backlog bug table), before any new UX slice.
3. Then UX2–UX5 → AB AI budget card → NY Needs You + Morning Review → SP phone measurement (re-read the backlog).

## Owner items

- Phone: Today → mood check-in on a day with no journal note yet → saves (B7).
- Phone: Dashboard → Health board; Report button → test Bug → Undo from Actions.
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.

## Budget

DeepSeek $8.59 (before the two flash runs). GLM ~140k/900k.
