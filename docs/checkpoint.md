# Checkpoint — 2026-10-02 (B12)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **B12** (Lead contract + 2 parallel workers: kernel Pro, web Flash; ADR-0042; pnpm check 1855 + e2e 104): tap a Run/Gym row in Training → sheet prefilled → `EditTraining {row, session}` replaces the row with exact cells (moves on date change); `UndoEditTraining` = exact inverse. GLM raised 8 majors over 2 passes, all verified invalid by the Lead.
- **B9** (Lead, ~5 lines): BTC history was blank because Coinbase `/candles` returns 400 without a User-Agent (`/ticker` does not); market fetches now send `User-Agent: vault-companion`; test asserts it.
- **B11** (worker + Lead fix; ADR-0041): Log training → Workout select gains "Group training" with a required free-text Class name and up to 6 one-tap suggestions from logged rows. Row stays Type `Gym`, Split cell `Group: <class>` (pipe/backslash escaped); Group without a name ⇒ `refused:invalid-edit`.
- **Live before UX1: `f0580812`** (B5+B6, main 6dc275c). UX1 is deployed right after its merge; the new version ID
  and rollback target are in `.agent/decisions.md`.
- **UX1** (worker, check clean; pnpm check 1819 + e2e 102): bottom tab bar Today · Scouts · Notes · Log · More
  (More → Progress/Dashboard/Status/Actions); specs navigate via `e2e/nav.ts` `goTo`. Lead fix: a CSS `::after`
  chevron needs `content: '›' / ''`, else WebKit puts it in the button's accessible name.
- **B8** (Lead, ~20 lines): Mood/Energy chip rows get a visible label and scale-end hints (−3 low/drained,
  +3 great/energised); e2e `mood.spec` asserts them. Accessible group names unchanged.
- **B7** live: `renderDailyNote` formats `{{date:<fmt>}}` (YYYY MMMM MM dddd DD D, separators ` ,./-`); else refusal.
- **B5+B6** (worker, handoff-check clean; pnpm check 1819 + e2e 102): a newer prefetch key aborts the running warm
  sequence (one sequence at a time); `ScoutStatus.runStatus`/`aiHealth` turn an unknown enum into `null` instead of
  dropping the whole scout record.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **UX1b** navigation revision (owner 2026-10-02, Ready Backlog 'Navigation revised by Evgeny'): bar Today · Tasks · Scouts · Notes · Log, no More; overrides UX1–UX3. Deploy when green.
2. **HC3** fresh health data (owner step 1 done: Access app + AUD on /api/health/ingest only; security ADR, `-Reviewer both`, deploy, ACTION NEEDED when live).
3. Then UX2–UX5 → AB AI budget card → NY Needs You + Morning Review → SP phone measurement (re-read the backlog).

## Owner items

- Phone: Progress → Training → tap a session → change a value → Save changes; Actions → Undo restores it (B12).
- Phone: Log training → Workout → Group training → type a class → Save; next time it is offered as a suggestion (B11). BTC card shows 1W/1M/3M history (B9).
- Phone: bottom bar → More → each sub-screen and back; bar clears the home indicator (UX1).
- Phone: Today → mood check-in on a day with no journal note yet → saves (B7); rows labelled (B8).
- Phone: Dashboard → Health board; Report button → test Bug → Undo from Actions.
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.

## Budget

DeepSeek $8.23. GLM ~225k/900k.
