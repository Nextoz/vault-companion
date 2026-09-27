# ADR-0020 — Scout status page (increment S Part 2)

**Status:** accepted (owner chose S after C, 2026-09-26; output-note roots decided 2026-09-27). Brief:
`docs/briefs/S2-scout-status-page.md`. Read-only: the app never starts, stops or configures a scout.

## Source

S Part 1 (vault side) writes one tracked JSON file per scout in `Automation/Scout Status/`, at start and end of every
run, including failures. Shape observed from the first real file (schemaVersion 1): `scoutId`, `displayName`,
`schedule`, **`expectedEveryHours`**, `lastAttemptAt`, `lastSuccessAt`, `runStatus`, `sources {configured,successful}`,
`aiHealth`, `findings`, `added`, `errors`, `lastError`, `latestOutput`, `history[{at,status,findings}]` — **most fields
may be `null`** (unknown), which is never shown as healthy.

## Read model

`GET /api/scouts` at one pinned commit X: regular `*.json` files directly in `Automation/Scout Status/` (≤ 50 files,
each ≤ 64 KB). Each file is parsed tolerantly: known fields validated, unknown fields ignored, a file that fails
validation becomes `{ file, state: 'unreadable' }` ("No status yet", never green). The response carries the server's
`now` so staleness does not depend on the phone clock. `lastError` is shown as one line, truncated to 200 characters.

Derived display state (client, pure function, unit-tested):
- **Running**: `runStatus = running` and the attempt is newer than the last success;
- **Failed**: `runStatus = failed`; **Degraded**: `degraded`; **Healthy**: `success`;
- **Stale** overrides the above when `expectedEveryHours` is set and `now − lastAttemptAt > 1.25 × expectedEveryHours
  + 1 h` (no attempt within the schedule plus grace);
- missing/unknown status ⇒ **No status yet**. "Found nothing" (`findings = 0`, success) stays Healthy, distinct from Failed.

## Findings note

`GET /api/scouts/output` with header `X-VC-Scout: <scoutId>`: the server re-reads that scout's status file at X and
renders its `latestOutput` note through the existing linked-note rendering (sanitised, read-only, 1 MB cap, symlinks
never followed). **Owner decision (2026-09-27): any folder a status file names** — the one exception to the
linked-note root allowlist (`LINKED_NOTE_ROOTS` does not apply). What still applies is `canReadScoutOutput` in
`paths.ts`: `isStructurallySafePath` (vault-relative, no `..`/absolute/backslash/`%`/control characters) **plus** `.md`
only **plus** the linked-note segment rule (no segment starting with `.`, no denied segment such as `Tools`, `tmp`,
`output`). The path is NFC-normalised before validation and lookup. The client never supplies a path.

## UI

Grafana-style dark panel grid (one panel per scout: state colour + label, relative last run, findings as a big number
with a sparkline from `history`, chips for sources and AI), a detail view (run-history strip, last success/attempt,
last error, findings note), and a Today indicator "N scouts need attention" only when any scout is Failed or Stale.
Accessible contrast on dark panels; readable at phone width.
