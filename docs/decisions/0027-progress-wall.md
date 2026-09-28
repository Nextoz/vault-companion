# ADR-0027 — Progress Wall inside History (increment P, read-only)

**Status:** accepted (owner decisions 2026-09-28: lives inside History; v1 sources = what the app already reads).
Idea: Ideas Backlog *Progress Wall*. Read-only and derived; nothing new becomes canonical; no new vault read roots.

## What

The History tab is renamed **Progress**. Top: a **"This week"** card (Monday–Sunday, Europe/Copenhagen) showing what
actually happened, as counts with the evidence one tap away. Below it, **Earlier weeks** (the previous 7 weeks, newest
first, each collapsed to its one-line summary, tap to expand). Below that, the existing day-by-day completion list,
unchanged.

## Sources (v1) and what each contributes

| Source (existing read) | Counted in a week | Evidence on tap |
|---|---|---|
| `/api/history`, `source: todo` | tasks completed (`doneDate`) | the task line; its linked note |
| `/api/history`, `source: active-work` | Active Work items finished | the item line |
| `/api/training` rows | runs (count, total km) and gym sessions (count, splits) | the session rows |
| `/api/triage` decisions | events you said **Go** to; events attended (`attended` with `worth`/`not-worth`, T2) | event title and date |
| `/api/notes` (Inbox notes with a date) | notes written | open the note |

Undone decisions are excluded (latest non-undone decision per event, as in ADR-0024). A week line reads like
"6 tasks · 2 Active Work · 3 runs (14.6 km) · 1 gym · 1 event · 2 notes"; zero sources are omitted; an empty week says
"Nothing recorded this week" without judgement.

## Server change (one, read-only)

`/api/triage` decision list entries gain the snapshot already stored in each decision line: `title` and `start` (from
`card`), and `outcome` for `attended`. No new files are read; the decision files are already read for this route.

## Rules

- Counts are evidence, not scores: **no streaks, targets, comparisons with other weeks, or "streak debt"** wording.
- Each source loads independently; a failed source shows "Training unavailable" (etc.) in the card and the rest stays.
- Week boundaries use Copenhagen calendar dates (DST-safe), never 7 × 24 h.
- Journal entries, job applications and Git commits are out of scope for v1 (new read roots need an ADR).
