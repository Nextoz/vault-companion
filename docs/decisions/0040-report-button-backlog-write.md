# ADR-0040 — Report button writes one line into the owner's Ready Backlog
Status: accepted (Lead, 2026-10-02, under the owner's FB1 brief).
## Context
The phone needs a lightweight bug/wish report. The owner's triage target is the existing
`Projects/Vault Companion/Vault Companion - Ready Backlog.md`, so the app must add one structured line to
existing `Bug backlog` / `Candidates to refine next` sections without creating or reformatting the note.
## Decision
- Write target is the exact constant in `paths.ts`; `canWrite` allows update only, never create, and no
  client-supplied path is accepted.
- `ReportFeedback` sanitises text and inserts either one bug-table row or one wish bullet. Missing/duplicate
  structure is a typed refusal, file untouched.
- The wire effect is `{ kind: 'report', op: 'reported' | 'undone' }`; no report text enters effects or logs.
- `UndoReportFeedback` replays the target commit on its parent, verifies the resulting blob, then removes
  exactly the written line; absent/duplicated lines are `conflict:report-changed`.
## Consequences
`vault-contract.md` gains §9. Bug numbering is inferred from the current note (`max B<n> + 1`), not stored.
If the note is renamed or moved, reports fail closed until the constant is updated; that change is an ADR.
