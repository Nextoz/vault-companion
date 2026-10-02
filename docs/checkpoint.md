# Checkpoint — 2026-10-02 (FB1+FB2 deployed)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **Live: `a512378b`** (FB1+FB2, main c3fe2c7). Rollback target `4deb8252`.
- **FB1** — `ReportFeedback` / `UndoReportFeedback` (ADR-0040): the only target is the Ready Backlog note (update
  only, never create). Bug ⇒ row `| **B<n> - <first 6 words>** | <date> <screen> (app <ver>): <text> | | |` directly
  under the Bug backlog table separator (n = 1 + max `B<digits>` in the note); wish ⇒ bullet after the last item of
  the first list under "Candidates to refine next". Table/list must sit in its own section. Text whitespace-collapsed,
  `|` escaped. Undo replays on the parent and removes exactly that line; edited/duplicated ⇒ `conflict:report-changed`.
  Web has type plumbing only (labels "Report", "Undo report").
- FB1: DeepSeek Pro one run (Jev pro 0.72 = high-risk floor). Check `-Reviewer both`: 7 majors, 1 valid (section
  scope) fixed by the Lead with negative tests; 4 claimed invalid error codes were false (codes exist); whole-note
  B-number scan is intentional (avoids reusing numbers mentioned in prose).
- **FB2** — header "Report" button on every tab → sheet (text + Bug/Wish); screen = tab name, appVersion = build
  commit; queued offline; Undo from Actions (mood pattern). Worker sandbox cannot launch WebKit: Lead runs iPhone e2e.
- Launcher gotcha: in the Lead's PowerShell `bash` resolves to WSL; prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. AB AI budget card → NY Needs You + Morning Review → SP phone measurement (re-read the backlog note first).

## Owner items

- Phone: Dashboard → Health board shows your real numbers (refresh the CSV with `Tools/apple_health_daily.py` first).
- Phone: Report button (any tab) → a test Bug lands in Ready Backlog → Undo from Actions.
- Phone: Mood check-in → Undo from Actions; SP1 read-speed list (Today → "Vault updated").
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.

## Budget

DeepSeek $8.59. GLM ~140k/900k.
