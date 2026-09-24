# ADR-0010 Phone task captures go to the top of `## Open`

Status: Accepted — owner decision D4, 2026-09-24

**Context.** Spike S5b: a desktop QuickAdd capture and a phone capture, both appended at the end of `## Open`
within one sync interval, produce a Git textual conflict for the desktop worker. Spike S6: edits to distant lines
merge cleanly.

**Decision.** The app inserts captured tasks immediately before the first non-blank line of `## Open`
(`vault-contract.md` §4.4). QuickAdd keeps appending at the end.

**Consequences.** The most common concurrent case merges without conflict. Newest phone captures appear first
in Open. Residual conflict: a desktop edit to the first Open task line in the same interval.
