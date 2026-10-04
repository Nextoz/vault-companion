# ADR-0055 — Morning Brief reliability: status record, catch-up window, observability, proof-run hook

**Status:** accepted (Lead, 2026-10-04). Consequential because the brief is a private derived artifact and a silent
failure left no trace after Workers Free dropped unobserved invocation logs.

## Decision

- **Never silent.** Every Morning Brief run except the skipped-by-hour-guard case writes
  `Automation/Scout Status/morning-brief.json` with the shared `ScoutStatus` contract, display name "Morning Brief".
  Success, fallback/degraded and failed runs are recorded; a failed brief still writes the failure record best-effort.
  `lastError` carries only a fixed code (`internal`, `not-written:<reason>`, `unavailable:<source>,...`), never brief,
  task, note or mail text.
- **Catch-up window.** The Copenhagen run window is hours 6..11, not only 06:xx. The primary crons stay `31 4` and
  `31 5`; UTC crons `31 6` and `31 7` are catch-up slots. The existing date dedupe remains unchanged, so a late retry
  never double-commits.
- **Observability.** `apps/worker/wrangler.jsonc` enables Workers log persistence (`observability.enabled: true`).
- **Proof-run hook.** The plain var `BRIEF_ANY_HOUR === '1'` skips only the local-hour guard. It is a non-secret
  setting for one live proof run, never a path to bypass dedupe, CAS, allowlists or budgets.
- **Budget.** The brief keeps the same `≤ 45` subrequest budget as the explainer. The cron composition pins one head
  for all vault gatherers, and the status write is reserved for by the budget check. The full-gather reproduction
  (vault, Google calendar and mail, weather, Scaleway) measures exactly 45 fetches in `morning-brief-budget.test.ts`.
- **Client fallback.** `GET /api/morning-brief` now returns a `missing` result with the status record's `lastError`
  when no brief file exists; the web card shows "No brief yet" plus that fixed code. A stale brief still falls back to
  the existing card lines unchanged.

## Consequences

One new allowlisted write path (`Automation/Scout Status/morning-brief.json`), two extra cron triggers, and a new
read response union consumed by the Today card. The owner can trigger one off-window proof run by setting
`BRIEF_ANY_HOUR=1` in the Worker vars, then removing it.
