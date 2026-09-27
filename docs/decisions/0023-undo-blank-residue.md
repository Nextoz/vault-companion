# ADR-0023 — Semantic Undo removes its recorded blank line in Done (R7)

**Status:** accepted (2026-09-27, Lead; review follow-up R7). Amends vault-contract §4.2 "Blank residue".

## Context

Completing a task into a `## Done` without task lines inserts the block after Done's last non-blank line, preceded by
one blank line when that line is not a list item; the completion effect records this as `blankInserted`. The semantic
inverse (used when the file changed since the completion, so the exact inverse does not apply) removed that blank only
when Done had no other non-blank content. With other Done content (notes, prose) Undo left a stray blank line —
reproduced with a golden test before this change.

## Decision

The semantic inverse removes **exactly one** blank line — the line directly above the restored block — when the
completion recorded `blankInserted` **and** that line is still blank, regardless of other Done content. It never removes
any other line, and nothing when the desktop already removed or replaced the blank.

## Consequence

Known residual: if the desktop later inserts its own paragraph followed by a blank line directly above that completed
task, Undo removes that blank line instead of the original one. It is one line of spacing, never text; accepted.
Golden tests cover content above/below, Done above/below Open, desktop-removed/replaced blanks, CRLF and no final
newline; the `blankInserted`, still-blank and single-line guards are mutation-checked.
