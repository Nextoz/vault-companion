# Brief D — Completion history (owner-refined 2026-09-26)

Read `AGENTS.md`. Synthetic data only.

**Outcome:** the owner scrolls back day by day and sees which tasks were completed.

## Build

- A **History** view: completed tasks grouped by day, newest day first, by the `✅ YYYY-MM-DD` done date
  (Europe/Copenhagen dates, as written in Markdown).
- Sources: `Tasks/To-Do List.md` (`## Done`) and the `## Dropped or done` section of `Tasks/Active Work Now.md`
  (`- [x] … ✅ YYYY-MM-DD` lines written by increment C). No other checklists in the vault.
- Tasks only: no notes, journal entries or Git activity.
- Tap a task → its line and linked note (existing linked-note path). **Reopen** is allowed for To-Do List tasks via
  the existing Undo/reopen command path; no new mutation for Active Work items unless C provides one.
- No streaks, counts-as-scores or targets. Cancelled (`❌`) items are not completions.

## Data

Read-only except Reopen; everything derived from Markdown on read (no new store, ADR-0009). Bounded read budget:
reuse the existing task read and add at most one extra file read; measure CPU (Workers Free).

## Done means

1. History lists completed tasks by day from the real files, newest first.
2. Items from both sources appear under the right day; cancelled items do not.
3. Tapping shows the line and linked note; Reopen works with Undo for To-Do List tasks.
4. No scores/streaks. Owner phone test.
