# Checkpoint — 2026-10-02 07:40 (Mood M2 merged #87)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: `35c44728`** (main `0e5b3cc`: UI refresh 1–5, SP3a/b/c, SP1 measure #67–#83). Rollback target `f5ea4843`.
- **main `c024666`:** + #86 sandboxed workers (`tools/launch-worker.ps1` is the only worker launcher) + #87 Mood M2
  (`MoodCheckin`/`UndoMoodCheckin` → `Journal/Daily/<date>.md`, ADR-0036; API only, no UI yet). Not deployed:
  deploy it together with M3 so the new write target ships with its UI.
- **Workers work again:** codex with `-s workspace-write` (no bypass flag) passes the classifier; vitest and file
  writes run inside the Windows sandbox. M2 ran on DeepSeek Pro, one run, ~143k tokens, handoff-check CLEAN.
  Correction rounds: `tools/launch-worker.ps1 … -Fix` (reads `.agent/run-<task>.log`).
- **Phone (owner, 07:20):** app opens, new UI shows, looks fine so far; more testing pending. The earlier
  "fails on the phone" problem appears resolved.
- Production deploys are still owner-run (classifier). GLM via opencode: trial failed overnight (silent exits).
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).
- Overnight report: `.agent/overnight-report.md`; decisions `.agent/overnight-decisions.md`.

## Next actions (in order)

1. **Mood M3 — Today mood card** (UI for M2: check-in form, Undo via the queue — `apps/web/src/queue/queue.ts`
   undo lists must include `UndoMoodCheckin`). Brief from ADR-0036 + vault Ready Backlog; Jev picks the tier
   (UI over a high-risk write ⇒ at least Flash, Lead reviews the queue change). Then ask the owner to deploy M2+M3.
2. SP: after the owner's phone timings (SP1 panel), target the slowest route; Today/task last-copy only with its own review.
3. Then the Ready Backlog order (re-read the vault backlog note, not this list alone).

## Owner items

- On the phone: Today → tap "Vault updated" → after a few tabs, note the read-speed list (SP1 timings).
- Phone acceptance of the UI refresh, Dashboard/Weather, Training, Progress, Notes/Radar, offline "Stale" copies.
- Review ADR-0036 (Mood), ADR-0037 (UI tokens), ADR-0038 (last copy); decide on `git stash@{0}`.

## Budget

DeepSeek $9.49 (07:37). GLM-5.2 ~24k/900k. RAM 4.5 GB free at 07:37. CodeRabbit: 1 CLI review used at ~07:22.
