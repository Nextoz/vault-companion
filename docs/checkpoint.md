# Checkpoint — 2026-10-02 (UX1b)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **UX1b** (Flash worker, check clean; Lead fixes; pnpm check 1856 + e2e 104): bar Today · Tasks · Scouts · Notes ·
  Log, no More. Tasks = Today/All switch + Active Work + Today/Overdue/Done. Today = cockpit ("N tasks today" →
  Tasks, Morning, Mood, Weather, Scouts, Triage, Dashboard boards). Log = Training/Progress switch. Header status dot
  (red/yellow/green) opens Status: Back + Actions. Lead fixes: dot ignores `saved` queue items; Today's Dashboard
  mounts only after the first read settles (else its reads ran 3× on app open, caught by `dashboard.spec`
  `healthReads`); e2e `name: 'Task'` selectors now `exact` (collided with "Tasks"). Screenshots: clone `.agent/shots`.
- **B12** (ADR-0042): tap a Training row → edit sheet → `EditTraining`; `UndoEditTraining` exact inverse. Live.
- **B9** BTC history (User-Agent on Coinbase); **B11** Group training (ADR-0041); **B8** mood labels; **B7** daily
  note date tokens — all live.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Workers cannot run Playwright; e2e failures surface only in the Lead's run — budget a Lead fix pass for UI slices.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **HC3** fresh health data (owner step 1 done: Access app + AUD on /api/health/ingest only; security ADR,
   `-Reviewer both`, deploy, ACTION NEEDED when live).
2. Then UX2–UX5 (UX1b overrides them where they differ: no More; Status from the dot only) → AB AI budget card →
   NY Needs You + Morning Review → SP phone measurement (re-read the backlog).

## Owner items

- Phone: bottom bar Today · Tasks · Scouts · Notes · Log; Tasks → Today/All; Log → Training/Progress; status dot →
  Status → Back (UX1b). Tell me if the cockpit order on Today feels right.
- Phone: Log → Training → tap a session → change a value → Save changes; status dot → Actions → Undo (B12).
- Phone: Log training → Workout → Group training → class → Save; suggestion next time (B11). BTC 1W/1M/3M (B9).
- Phone: Today → mood check-in on a day with no journal note yet → saves (B7); rows labelled (B8).
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.

## Budget

DeepSeek $8.12. GLM ~225k/900k.
