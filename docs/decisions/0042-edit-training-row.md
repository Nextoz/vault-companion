# ADR-0042 — Edit one logged training session (B12)
Status: accepted (Lead, 2026-10-02, under the owner's B12 backlog item). Amends ADR-0025 "Not included" (editing).
## Context
Logged workouts could not be corrected (type, class name, numbers, date). ADR-0025 allowed only inserts + exact Undo.
## Decision
- `EditTraining { row, session }`: `row` is the exact parsed `TrainingRow` the phone read; the kernel edits the one
  session row whose 8 cells equal it. None ⇒ `conflict:training-changed`; several ⇒ `conflict:ambiguous`; a result
  identical to the old line ⇒ `refused:invalid-edit`. The new line is the canonical `formatTrainingRow(session)`.
- Same (Date, Time) ⇒ the line is replaced in place. A changed date/time ⇒ the line is removed and re-inserted by
  the `LogTraining` ordering rule, so the table stays newest-first. Every other byte is unchanged.
- `UndoEditTraining { target, targetCommit }` reuses the ADR-0025 exact-inverse Undo (byte-identical file ⇒ parent's
  bytes; else "undo it in Obsidian"). Effect `training/edited`. CAS, operation ID, trailers, dedupe as every write.
- Editing a legacy row rewrites it in canonical form (units normalised); the phone prefills what it can parse.
## Alternatives
- Locate by line number/index: silently edits the wrong row after an Obsidian change. Rejected.
- Delete + new LogTraining: two commits, no atomic Undo. Rejected.
- Always move (remove + insert): reorders rows with equal timestamps on a pure value fix. Rejected.
