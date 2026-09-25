# ADR-0012 — Today definition for the first release

**Status:** accepted (owner decision T1, 2026-09-25; provisional — revisit after daily use).

**Context.** The repo contract used `≤ today` for due, scheduled and start dates with Overdue above Today; the vault
Build Contract said `= today`. The vault's `Tasks/Active Work Now.md` holds the owner's chosen outcomes, which the
date/priority rule cannot express. An independent review (2026-09-25) asked for one visible behaviour.

**Decision.** Four signals stay separate: Active Work Now shown read-only on top (no inferred task mapping); Today =
`📅` = today, or `⏳` ≤ today, or priority 🔺/⏫; Overdue = `📅` < today, collapsed group below Today; `🛫` alone is
"available", not Today. See `docs/product-contract.md`.

**Consequences.** Pure read-model change (`packages/domain` read model + web view); no stored state, no migration, so
it can change again cheaply. Active Work Now needs the sanitised renderer from the linked-notes work (P4-A).
