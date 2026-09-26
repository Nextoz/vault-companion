# Brief S Part 2 — Scout status page (owner-chosen after C)

Read `AGENTS.md`. Synthetic data only. **Blocked until S Part 1 exists:** the vault side writes one tracked JSON
status file per scout under `Automation/Scout Status/`, updated at start and end of every run, including failures.
The Lead captures the real shape once those files exist and replaces the illustrative shape below; never invent it.

**Outcome:** one page shows every scout at a glance (last run, health, findings) and a tap shows what it found; a
Today indicator reminds the owner when something needs attention.

**Why:** a failed run must not look healthy. State files that are only written on success showed green while every
scout had failed to start.

## Illustrative status shape (synthetic — replace with the real Part 1 shape)

```json
{ "schemaVersion": 1, "scoutId": "events-city", "displayName": "City events", "schedule": "daily 06:50",
  "lastAttemptAt": "2026-09-26T06:50:02+02:00", "lastSuccessAt": "2026-09-25T06:55:57+02:00",
  "runStatus": "failed", "sources": { "configured": 12, "successful": 12 }, "aiHealth": "healthy",
  "findings": 9, "added": 2, "errors": 1, "lastError": "runner could not start",
  "latestOutput": "Events/City Events/City Events - 2026-09-25.md",
  "history": [ { "at": "2026-09-25T06:55:57+02:00", "status": "success", "findings": 9 } ] }
```

`runStatus`: `running | success | degraded | failed`; `history`: last 30 runs.

## Build (read-only)

- **Page, Grafana-style:** dark panel grid, one panel per scout: status colour + label — Healthy, Degraded,
  **Failed**, or **Stale** (no attempt within schedule + grace); last run as relative time (a newer failed attempt
  wins over the last success); findings as a big number with a sparkline from `history`; chips (sources n/m, AI ok).
- **Detail:** run-history strip (coloured block per run), last success, last attempt, last error; the `latestOutput`
  note rendered with the existing sanitized note renderer (new read allowlist root for `Automation/Scout Status/`
  and the scouts' output roots — ADR).
- **Today indicator:** "N scouts need attention" only when any scout is Failed or Stale; links to the page.
- Rules: no start/stop/config from the app; "found nothing" ≠ "failed"; missing/unreadable status ⇒ "No status
  yet", never green; accessible contrast on dark panels; readable at phone width.

## Done means

1. The page lists every scout with correct status, attempt/success, findings and sparkline from the real files.
2. A deliberately failed run shows Failed within one sync cycle; a missed schedule shows Stale.
3. Tapping a scout shows the history strip and its latest findings note.
4. Today shows the indicator only when something is Failed or Stale.
5. Owner phone test.
