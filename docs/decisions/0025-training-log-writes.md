# ADR-0025 — Training log: one-row inserts into `Health/Training Log.md` (increment L)

**Status:** accepted (owner designed L in the Ready Backlog, 2026-09-28; the owner allows app writes to exactly this
file). First app write under `Health/`. Amends vault-contract §1 (one new read/write target).

## Table grammar

The note has a `## Sessions` heading (compared after trimming). The **sessions table** is the first Markdown table
after it, before the next `##` heading, with exactly this header (cells trimmed, case-sensitive):
`| Date | Time | Type | Distance | Duration | Weight | Split | Note |` followed by a separator row.

A **session row** is a table row with 8 cells whose `Date` is `YYYY-MM-DD` and whose `Time` is `HH:MM` or empty.
Other cells are free text; the reader tolerates units (`5.2 km`, `28 min`, `82.4 kg`) and any `Type`/`Split` value
(legacy rows such as a group workout are shown with what they have). Any other line inside the table (wrong cell
count, bad date) is **unknown**: shown read-only, never rewritten, moved or dropped. Everything outside the table
(week summaries, "Worth keeping…" sections, frontmatter) is never read for display and never changed.

No `## Sessions` heading, no table, a different header, or two candidate tables ⇒ typed refusal
`refused:training-table-missing` ("Training log table not found — fix it in Obsidian"). Never a guess.

## Written row (canonical format)

`| 2026-09-28 | 18:42 | Run | 5.2 | 28 | | | Easy loop |` — Date and Time in Europe/Copenhagen from `when`; `Type`
`Run` or `Gym`; numbers without units (Distance km with one decimal, Duration whole minutes, Weight kg with one
decimal); `Split` one of `Bicep`, `Tricep`, `Legs` (Gym only); empty cells are one space. The note is one line: newlines
become spaces, `|` is escaped as `\|`, leading/trailing space trimmed, ≤ 280 characters. The formatter is one function,
so the unit style can change in one place if the owner's table uses units.

## Commands

| Command | Effect |
|---|---|
| `LogTraining {session}` | insert one row: before the first session row whose (Date, Time) is strictly older; else after the last row of the table. Unknown rows are skipped when comparing. Newline style of the file is kept. |
| `UndoLogTraining {target, targetCommit}` | exact inverse only (ADR-0013/0019 pattern): if the file is byte-identical to the target commit's blob, write the parent's bytes; otherwise refuse ("undo it in Obsidian"). |

Validation in `packages/contracts` (zod): Run needs distance 0.1–100 and duration 1–600; Gym needs split and duration
1–600, weight optional 30–250; `when` an offset date-time not more than 1 day in the future. Head-CAS, blob-SHA CAS,
operation ID, commit trailers and dedupe exactly as every other write (ADR-0005/0011/0015). A retried `LogTraining`
whose operation ID is already in history is a no-op (existing dedupe); a stale base re-reads and re-inserts against
the newest version (a row insert is safe to replay).

## Paths

Read and update `Health/Training Log.md` only (`canWrite(path, 'update')`); never create it, never any other path
under `Health/` (`canWrite` stays false for them; a test proves a sibling like `Health/Other.md` is refused).

## Privacy

Health data stays in the owner's private vault repo. Fixtures are synthetic but copy the table shape (header,
separator, legacy row styles). No row values in logs.

## Not included

Editing or deleting past rows, charts, trends, streaks, targets, reminders.
