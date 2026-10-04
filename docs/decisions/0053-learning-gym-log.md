# ADR-0053 — Learning Gym Log: one-row inserts into `Personal/Learning Gym Log.md`

**Status:** accepted (Lead, LG1a). Amends vault-contract §1 (one new read/write target).

## Grammar

The note has one `## Kinds` heading and one `## Log` heading (trimmed). Each section contains exactly one Markdown
table before the next `##` heading.

- Kinds table header: `| id | Name | Score means | Status |`. A **kind row** has four cells and a non-empty `id`;
  adding a row to this table makes that `id` available with no app change.
- Log table header: `| Date | Kind | Min | Score | Detail | Topic or source | Note |`. A **log row** has seven cells
  and a valid `Date` (`YYYY-MM-DD`). Any other line inside the Log table is **unknown**: shown read-only, never
  rewritten, moved or dropped. Everything outside these tables is never read for display and never changed.

Missing `## Log`/`## Kinds`, no table, a different header, or two candidate tables ⇒
`refused:learning-table-missing`. A `kind` not present in the Kinds table at write time ⇒
`refused:learning-kind-unknown`. Never a guess.

## Written row (canonical format)

`| 2026-10-04 | dictation | 15 | 7 | acc 8, spell 7 | weather report | |`

One new row, always at the end of the `## Log` table. `Min` is a whole number; `Score` is a number or `3/5`-style
text (≤ 8 chars); every cell is one line; `|` is escaped as `\|`; an empty cell is one space. The file's BOM, EOL and
final-newline state are preserved; all bytes outside the splice stay byte-identical.

Paste helper grammar: `LG | <kind> | <YYYY-MM-DD> | min <n> | score <n> | <key> <n> ... | topic: <text>`.
Unknown `<key> <n>` pairs become `detail` as `key n, key n`. Malformed ⇒ `refused:learning-paste-invalid`.

## Commands

| Command | Effect |
|---|---|
| `LogLearning {session}` | insert one canonical row at the end of `## Log` (Kinds checked first). |
| `UndoLogLearning {target, targetCommit}` | exact inverse only (ADR-0025 pattern): byte-identical file ⇒ parent bytes; else refuse. |

Every write uses operation ID, base revision, head-CAS, blob-SHA verification, commit trailers and dedupe exactly
like `LogTraining`.

## Paths

Read and update `Personal/Learning Gym Log.md` only (`canWrite(path, 'update')`); never create it, never any sibling
or nested path.

## Privacy

Personal learning data stays in the owner's private vault. Fixtures are synthetic but copy the table shape. No row
values in logs.

## Not included

Editing a past row, streaks, targets, reminders, or interpreting the semantics of kinds other than the one `id`
cell needed for validation.
