# ADR-0041 — Group training names its class in the Split cell
Status: accepted (Lead, 2026-10-02, under the owner's B11 brief).
## Context
The owner joins group classes (e.g. "Functional Express"). The Log-training sheet offered only Bicep /
Tricep / Legs, and the fixed sessions table has no column for a class name.
## Decision
- `split` gains `Group`; a required, trimmed 1–60 char `className` (no CR/LF/U+2028/U+2029) is allowed
  exactly when `split = 'Group'` and refused otherwise; `Run` carries none.
- The header is unchanged. The Split cell becomes `Group: <class name>`, escaping `\` and `|` exactly like
  the Note cell, so existing Bicep/Tricep/Legs rows stay byte-identical.
- Suggestions come from the cached training read: rows whose split starts `Group: `, distinct, newest
  first, at most six; a tap fills the free-text input.
## Consequences
`TrainingSession` stays a discriminated union on `type` (the Gym branch gains a `superRefine`); the select
label "Split" reads "Workout".
## Alternatives
B: a new `Type = Group` — changes the Type cell for every group row and fights the fixed header.
C: write the class in the Note — loses structure and cannot drive one-tap suggestions.
