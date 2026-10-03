# ADR-0049 — AI budget card in the Status sheet

Status: draft (Lead, 2026-10-03) under the owner's AB backlog item; consequential because it adds a fixed read path
and renders provider budget/usage data the app must never invent.

## Context
AB Part 1 (the vault-side writer) does not exist yet. AB Part 2 is the read-only card: it must show the file honestly
from a synthetic source, degrade safely, and never draw a number the file did not contain.

## Decision
- **One file:** exactly `Automation/Scout Status/ai-budget.json`. Fixed path, no client input, re-validated on every
  read (like MB2's Morning Brief). Missing file is a typed `not-found`; invalid JSON is a typed `invalid` refusal.
- **Schema:** `schema: 1`, `generatedAt`, `providers[]`, `freeRamGb`. Each provider has `id`, `label`, `kind`
  (`percent`|`money`|`count`), `value`, nullable `limit`/`unit`/`resetsAt`/`history`. The envelope is a
  `z.strictObject`; providers are parsed one by one, so an unknown `id`/`kind` (or any malformed entry) drops only
  that provider, never the file.
- **No secrets:** only counts, dollars and percentages the owner already sees in provider dashboards; no API keys,
  prompts or note text. Logs carry only the commit SHA.
- **Thresholds** are the owner's: percent used `<70` green, `70-89` yellow, `>=90` red; money `< $2` red, `< $5`
  yellow, else green; count `left <= 2` red, else green. Sparkline only with `>= 2` daily points. Freshness:
  "Updated HH:MM" (Europe/Copenhagen), yellow "Stale (> 2 h)" once `generatedAt` is over two hours old.
- **Why the Status sheet, not the Dashboard:** this is app/ops health, shown with Scouts and Data sources, not a
  day-plan metric; it also keeps the Dashboard's market/weather cards uncluttered.
- **Writer is vault-side (Part 1):** the Worker only reads here. The writer must emit exactly this schema.

## Alternatives
- Guess a value when the file is missing: rejected — the card says "No budget data yet".
- Fail the whole file on one bad provider: rejected — one new provider id must not hide the rest.
- Keep an in-memory last copy: skipped; the last-copy add is not two lines in this sheet.

## Consequences
`Automation/Scout Status/ai-budget.json` is the fixed read path. Part 1 must emit `schema: 1` with the provider fields
above; any drift breaks the contract tests, not the card.
