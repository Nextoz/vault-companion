# Checkpoint — 2026-10-02 (HC2 Health panel merged)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: `d9d3dff2`** (Mood M2+M3). Rollback target `35c44728`. HC1+HC2 merged, **deploy pending** (standing
  approval: deploy after CI, then verify and log in `.agent/decisions.md`).
- **HC1** — `GET /api/health` (ADR-0039): Worker reads only `Health/Data/Apple Health Daily.csv`; shown day = newest
  row ≤ yesterday, `staleDays`, four metrics vs a 90-day median baseline, 30-day series. No values in logs.
- **HC2** — `HealthPanel` on the Dashboard (cyan): four tiles (Steps, Headphones, First/Last move as HH:MM from
  minutes after 03:00), "Usual <baseline>" + Above/Below/Usual/Not enough history, sparklines with gaps, "Data from
  <day> — N days old" (stale style ≥ 3 days), missing/unreadable/failed messages, own last copy (key `health`).
  Loads independently of the market read. The placeholder Health overview card is hidden on the web.
- HC2: DeepSeek Pro one run (Jev pick, conf 0.19, $0.20); CodeRabbit 1 major (panel gated on the dashboard read)
  fixed by the Lead; Lead also scoped the SP3c e2e copy-note locator (Health has its own copy note).
- Launcher gotcha: in the Lead's PowerShell `bash` resolves to WSL; prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **Deploy HC1+HC2** (standing approval) if not yet done — check `.agent/decisions.md`; verify, log.
2. **FB Report button** — new vault write target (high-risk: Pro + `-Reviewer both`). Re-read the backlog note first.
3. Then AB AI budget card → NY Needs You + Morning Review → SP phone measurement.

## Owner items

- Phone: Dashboard → Health board shows your real numbers after the deploy (refresh the CSV with
  `Tools/apple_health_daily.py` first if it is old).
- Phone: Mood check-in → Undo from Actions; SP1 read-speed list (Today → "Vault updated").
- Review ADR-0036 (Mood), ADR-0037 (UI tokens), ADR-0038 (last copy), ADR-0039 (health); decide on `git stash@{0}`.

## Budget

DeepSeek $9.19. GLM ~100k/900k. RAM 2.8 GB free after e2e (below the 3 GB worker floor).
