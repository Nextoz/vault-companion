# ADR-0070 — Phone health v2: 15-minute phone slots, a phone metric registry and dual-source steps (HC6)

Status: **proposed** (Lead draft 2026-10-29 from the owner's decisions of 2026-10-28). Amends ADR-0043 (a second
payload version on the same route, more write targets) and ADR-0068 (ring ingest also refreshes one derived file).

## Context

The owner wants every step reading from two sources, phone and ring, and all iPhone health data kept losslessly in
the vault for later trend work: "I want all the data in the vault companion and to be in the vault eventually".
Ingest v1 (`POST /api/health/ingest`, `schemaVersion: 1`) sends seven types and keeps only a daily row in
`Health/Data/Apple Health Daily.csv`; the Shortcut does not filter by source, so steps that PulseLoop may mirror into
Apple Health would be double counted. Ring slots (ADR-0068) arrive only via `/api/health/ring/ingest` and start
2026-10-28. Phone history since 2024-02 exists only in the owner's `export.xml`. PulseLoop is the ring app; Vault
Companion is the archive: completeness and lossless storage outrank presentation.

## Decision

**Route and payload.** The same route `POST /api/health/ingest`, same service token and Access application (no
owner Access step), accepts `schemaVersion: 2`; version 1 stays accepted unchanged (the old Shortcut keeps working
during the switch). Version 2 body: `{"schemaVersion":2,"from":"<ISO>","sentAt":"<ISO>","samples":"<lines>"}`, one
text field, one line per sample: `Type|Start|End|Value|Unit|Source` (Shortcuts display name of the type, ISO 8601
dates with time, value as text, unit as text, the sample's source name). One field serves both Shortcut shapes (a
generic loop or copied blocks) and keeps the Shortcut free of per-type JSON keys. `from`/`sentAt` rules as v1
(≤ 8 days span, ≤ 5 min future skew). Version 2 is a superset: the Worker rebuilds the v1 sample sets from the v2
lines of the seven v1 types and writes the v1 daily row with the **unchanged** v1 aggregation, so the daily CSV stays
byte-compatible (golden test: equivalent v1 and v2 bodies produce identical bytes).

**Phone metric registry** (`packages/domain/src/phone-metrics.ts`, same pattern as `ring-metrics.ts`). One entry per
type: key, Shortcuts type name, HealthKit identifier (for the backfill), CSV column, accepted input units with their
conversion to the stored unit, value rule (int/decimals, bounds), slot aggregation, daily aggregation(s), `since`
(schema version). Parser, slot writer, daily derivation, read API and backfill all read it; a new type is one entry
plus a schema bump. `phone-slots/1` columns, in this order:

```
slot_start,steps,distance_km,flights,active_kcal,walking_speed_kmh,step_length_cm,asymmetry_pct,double_support_pct,steadiness_pct,six_min_walk_m,stair_up_mps,stair_down_mps,headphone_db,headphone_min,in_bed_min
```

Slot aggregation (deterministic, instant-based):
- `sum-prorata` (steps, distance, flights, active energy): a sample is split over the slots it overlaps in
  proportion to overlap time; integer types use largest-remainder rounding (ties to the earlier slot), so slot sums
  equal the sample total exactly. A zero-length sample goes to the slot containing its start.
- `mean` (walking speed, step length, asymmetry, double support, stair speeds): mean of the samples whose start lies in
  the slot. `last` (steadiness, six-minute walk: sparse estimates): the latest-starting sample in the slot.
- Headphone: `headphone_min` = union overlap minutes (0–15), `headphone_db` = energy mean over that overlap (as
  `apple_health_daily.py`). Sleep: `in_bed_min` = union overlap minutes of "In Bed" samples (0–15); other sleep
  categories are ignored (iPhone records only In Bed; ring sleep comes from the ring).
- Percent types are stored as 0–100. Stored decimals: distance 3, kcal 1, speeds and lengths 2, percent 1, minutes 1.
- A slot is written only if at least one value is non-null; missing stays empty, never 0 or interpolated.

**Slots and DST.** Slots are the ring's: 15-minute Copenhagen slots keyed on the instant, canonical `slot_start`
via `canonicalSlotStart` (ADR-0068). Copenhagen offsets are whole hours, so slot boundaries are UTC multiples of
900 s; the repeated October hour keeps two rows; phone and ring slots join on the instant. Monthly files
`Health/Data/Phone/Phone Slots YYYY-MM.csv` (Copenhagen month of the slot), rows sorted by instant.

**Window and idempotent merge.** A send recomputes every slot from its own samples. Slots starting before
`from + 1 h` are not written (samples that began before `from` are absent from the send); the current partial slot
is written and corrected by the next send. Merge per cell as ring slots: a non-null computed value replaces the
stored cell, `null` never erases, untouched rows and unchanged rows stay byte-identical, identical bytes make no
commit, header must equal a known `phone-slots/N` header (the first write after a bump upgrades the file once, new
columns appended, empty trailing cells). Malformed stored rows that a request touches ⇒ 409, never repaired.

**Source filter.** Every "Find Health Samples" filters by source (Shortcut steps in the HC6 brief). The Worker
backstops it: a line whose source contains `PulseLoop` (case-insensitive) refuses the whole request (422, line
number and type only). Source names are validated, never stored or logged. Ring data enters only via the ring route.

**Dual-source steps.** Raw phone steps (phone slot files) and raw ring steps (ring slot files) stay separate and are
never edited by each other. Per slot: combined = `max(phone, ring)` when both are non-null, the non-null one when one
is, empty when neither: both sensors count the same walking, so the larger is the better estimate of a real lower
bound and the sum would double count. Daily combined = sum of per-slot combined (not max of daily totals, which
would hide minutes where only one device was carried). The derived file `Health/Data/Activity Daily.csv`:

```
date,weekday,steps_phone,steps_ring,steps_combined,steps_phone_slots,steps_ring_slots,steps_both_slots,distance_km,flights,active_kcal,walking_speed_kmh,step_length_cm,asymmetry_pct,double_support_pct,steadiness_pct,six_min_walk_m,stair_up_mps,stair_down_mps,headphone_min,headphone_db,in_bed_min
```

Columns after `steps_both_slots` come from the registry's daily aggregations (new ones append). Rows are pure
functions of the merged phone and ring slot files of the Copenhagen calendar date, recomputed for the affected dates
at the write commit; both ingests refresh it (ring ingest: steps columns only change). A date with no slot in either
source is not written. Before 2026-10-28 `steps_ring` is empty and combined equals phone. The v1 `steps` column
(start-assigned) may differ slightly from `steps_phone` (pro-rata); v1 is kept as it is.

**Write path.** Version 2: sequential `executeWrite`s, oldest phone month first, then the v1 daily CSV, then Activity
Daily; op IDs `phone-slots:<YYYY-MM>:<hash32>`, `health-ingest:<hash32>` (as v1), `activity-daily:<hash32>`, CAS,
trailers, dedupe; plans read their inputs at their CAS commit, so a retry repairs a failed later write. Success
`{"ok":true,"days":[…],"slots":<n>,"months":[…]}`; failures `{"ok":false,"error":…}` with no values.

**Refusals (typed, whole request).** 400: not JSON, unknown `schemaVersion`, bad `from`/`sentAt`/span, `samples`
not a string, a line without 6 fields, unknown type name, unit not accepted for that type, value not a plain
non-negative number, bad date, end before start. 422: no Steps line (Health locked, as v1), a PulseLoop source, a
value outside its registry bounds (e.g. percent > 100), a sample outside `[from − 1 day, sentAt]`. 409: wrong stored
header or malformed touched row. Error text names line number, type and field only.

**Backfill (one-time, owner-run on the PC).** `tools/health-backfill/export_samples.py` (stdlib; reuses the
`iterparse` loop, date parsing and unit handling of the vault's `Tools/apple_health_daily.py`, copied as code, the
vault tool untouched) streams `export.xml` into a v2-format lines file **outside the repo** (refuses a path inside
it), filtering `sourceName` with the same rule and mapping HealthKit identifiers through a table generated from the
registry. A TypeScript CLI (`tools/health-backfill/build.ts`) feeds those lines through the **same domain functions**
(parse, slot aggregation, merge in `fill` mode where stored cells win, Activity Daily derivation) and writes the month
files into the owner's local vault checkout; dry-run by default (prints counts only), `--write` to write. The owner
pulls first, commits and pushes via the normal Obsidian Git path, like the existing daily CSV import. Ring history
starts 2026-10-28; nothing is backfilled for the ring.

**Privacy.** No health value or source name in logs, errors, commit messages, CLI output or fixtures; tests build
lines in code with sentinel values; the lines file lives outside the repo and is deleted after the import.

## Alternatives

- **Separate route `/api/health/phone/ingest`**: a new Access path for the owner and two Shortcuts posting
  overlapping data. Rejected; the schema version already distinguishes payloads.
- **One JSON key per type (v1 style)**: N variables and N dictionary rows in a hand-built Shortcut. Rejected.
- **Store raw samples**: lossless, but unbounded file growth and duplicates on resend without sample IDs (Shortcuts
  exposes none). Rejected; 15-minute slots are the owner's chosen resolution and `export.xml` stays the raw archive.
- **Combined = sum or phone-only**: sum double counts shared walking; phone-only loses ring-only minutes. Rejected.
- **Append ring/combined columns to `Apple Health Daily.csv`**: breaks byte-compatibility and the vault tool's file.
- **Backfill through the ingest route**: ~120 windowed requests, the service token on the PC, Workers Free CPU, and it
  would rewrite v1 daily rows from a different code path. Rejected. **Pure Python backfill**: a second aggregation
  implementation that drifts from the Worker. Rejected.

## Consequences

- A type is one registry entry + schema bump; old files stay valid; daily derivations plug into HC5-style analyses.
- Phone ingest makes up to four commits per send; CPU on Workers Free must be measured with a maximal synthetic body.
- Wrong stored values can only be removed by a manual vault edit (as ring slots).
- Units and percent scale reported by Shortcuts are verified on the first real send (the parser refuses an unknown
  unit, naming type and line).
