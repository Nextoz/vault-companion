# ADR-0006 Completion, Undo, recurrence and time policy

Status: Accepted

**Decision.**
- Completion: `[x]` + trailing ` ✅ <date>`, move the block to the top of `## Done` (newest first,
  matching the file's stated convention). Tasks already in Done complete in place.
- Undo: a new inverse command using the receipt's exact texts and Open anchor; conflicts when the
  completed line changed. Never restores an old file version.
- Recurrence: no recurring tasks exist in the vault; `🔁` tasks are `refused:recurring` for completion
  until successor generation is implemented and tested against Tasks' defaults
  (`recurrenceOnNextLine: false` ⇒ successor above).
- Dates: `Europe/Copenhagen` calendar date of the user's `occurredAt`; future skew > 5 min rejected;
  backdated > 14 days flagged.
- Done `## Done` is never trimmed (supersedes the vault note's "trim to ~20").

**Consequences.** Done today is a pure function of the file and today's Copenhagen date.
