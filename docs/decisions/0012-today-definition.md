# ADR-0012 — Today definition for the first release

**Status:** accepted (owner decision T1, 2026-09-25; provisional — revisit after daily use).

**Context.** The repo contract used `≤ today` for due, scheduled and start dates with Overdue above Today; the vault
Build Contract said `= today`. The vault's `Tasks/Active Work Now.md` holds the owner's chosen outcomes, which the
date/priority rule cannot express. An independent review (2026-09-25) asked for one visible behaviour.

**Decision.** Four signals stay separate: Active Work Now shown read-only on top (no inferred task mapping); Overdue
as a collapsed group below Today with its count always visible; `🛫` alone is "available", not Today. Precedence
(owner refinement, same day): deadlines today or overdue always surface a task; future start/scheduled dates keep
even high-priority tasks out of Today.

Rule (T = today in `Europe/Copenhagen`), evaluated in order for each open task:
1. `📅` < T ⇒ **Overdue** (always, whatever other dates say).
2. `📅` = T ⇒ **Today** (a deadline today beats any future start/scheduled date).
3. `🛫` > T or `⏳` > T ⇒ **not Today** (not yet available/planned, even at 🔺/⏫).
4. `⏳` ≤ T ⇒ **Today**.
5. priority `🔺`/`⏫` ⇒ **Today**.
6. otherwise ⇒ All tasks only. A future `📅` alone does not hold a priority task back.

**Consequences.** Pure read-model change (`packages/domain` read model + web view); no stored state, no migration, so
it can change again cheaply. Active Work Now needs the sanitised renderer from the linked-notes work (P4-A).
