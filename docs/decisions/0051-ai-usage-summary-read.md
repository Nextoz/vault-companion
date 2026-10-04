# ADR-0051 - AI usage summary read (AB3a)

Status: draft (AB3a, 2026-10-04) under the owner's AB backlog item; consequential because it adds a fixed read path
and renders per-provider daily usage the app must never invent.

## Context
AB2 reads the AI budget card (ADR-0049). A separate vault-side writer emits an AI usage summary with per-provider
daily rollups. Part 2 is the read-only projection: it must show the file honestly, degrade safely, and never draw a
number the file did not contain.

## Decision
- **One file:** exactly `AI/Usage/AI Usage Summary.json`. Fixed path, no client input, re-validated on every read.
  Missing file is a typed `not-found`; unreadable or bad-schema JSON is a typed `invalid` refusal, like the AI budget.
- **Schema:** `schema: 1`, `generatedAt`, `providers` keyed by provider id. Each provider has optional `label`,
  `currency`, `since` and a required `days` array; each day has `date`, `calls`, the four token counts and `cost`.
- **Per-entry isolation:** `providers` and `days` are parsed ONE BY ONE. An invalid provider or day entry is dropped
  and counted in `skipped`; unknown provider ids are kept (the vault side may add providers); unknown extra fields are
  ignored. Only the envelope (`schema`, `generatedAt`, `providers` object) can fail the whole file.
- **No secrets:** only counts, tokens and dollars the owner already sees in provider dashboards; no API keys, prompts
  or note text. Logs carry only the commit SHA.
- **Writer is vault-side:** the Worker only reads here. There is no new write target.

## Alternatives
- Fail the whole file on one malformed provider/day: rejected - one bad row must not hide the rest.
- Reject a file with an extra top-level field: rejected - the vault side must be able to add fields without a break.

## Consequences
`AI/Usage/AI Usage Summary.json` is the fixed read path (read-only, no new write target). Any drift breaks the
contract tests, not the card. The panel UI is a later slice.