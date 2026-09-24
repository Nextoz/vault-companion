# ADR-0003 Task identity for the first release

Status: Accepted (Lead, Phase 0) — flagged for owner review, non-blocking

**Context.** Native Tasks `🆔` is the preferred long-term direction (Tasks 8.0.0 supports it,
charset `[a-zA-Z0-9-_]+`, trailing-field parsed). The real vault contains zero IDs. The first-release
operations (complete, undo, capture) each act within one file on a task the user just saw.

**Decision.** Identity in the first release is a **revision-validated exact-content locator**
`{path, blobSha, lineIndex, lineText, occurrencesAtRead}` (`vault-contract.md` §3). Unchanged blob ⇒ exact line;
changed blob ⇒ unique exact-text match only if the text was unique when read (review F2), else conflict. The parser reads and preserves `🆔`; the app writes no
IDs in the first release. Lazy `🆔` assignment is deferred to the first feature that needs a reference that
survives edits (Focus references, Waiting, cross-file moves), after an ID compatibility test in real Obsidian.

**Alternatives.** Assign `🆔` on first mutation: adds a vault-convention change and a retry-dedupe case
(ID assignment) with no first-release benefit; completion moves the line anyway. Normalised-text hash:
fuzzy matching risks acting on the wrong task.

**Consequences.** A task edited on desktop between read and tap yields a conflict (user refreshes) —
acceptable for a single user. Duplicate identical lines are only actionable while the blob is unchanged.
