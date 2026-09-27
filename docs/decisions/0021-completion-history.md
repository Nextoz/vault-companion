# ADR-0021 — Completion history (increment D)

**Status:** accepted (owner-refined brief D, 2026-09-26; Lead decision on Reopen scope, 2026-09-27). Brief:
`docs/briefs/D-completion-history.md`. Read-only projection; no new store (ADR-0009).

## Read model

`GET /api/history` at one pinned commit X reads two files:
- `Tasks/To-Do List.md`: indexed tasks in `## Done` with status done and a parsed `✅` date (cancelled `❌` and
  undated done lines are excluded — no date means no day to group under);
- `Tasks/Active Work Now.md`: item lines in `## Dropped or done` that are `- [x] … ✅ YYYY-MM-DD` (written by
  increment C). `❌` drops and prose entries are excluded.

Response: `items[]` (source, description, done date, the line's locator, links) sorted newest date first, stable
file order within a day, capped at the newest 1,000 items (older days are simply not shown). The client groups by
day. Dates are the Markdown dates as written (Europe/Copenhagen dates by the vault contract); no scores, counts as
targets or streaks.

## Reopen

v1 reuses the existing Undo path only: a To-Do List item whose completion this device made and still holds a receipt
for gets **Reopen** (the existing `UndoCompleteTask`, ADR-0013). Everything else shows "reopen in Obsidian". A general
`ReopenTask` for desktop completions would be a new mutation and is left for a later decision.

## Budget

Two file reads + one head per request; parsing reuses the existing kernel parsers. Measure CPU on the live log after
deploy (Workers Free).
