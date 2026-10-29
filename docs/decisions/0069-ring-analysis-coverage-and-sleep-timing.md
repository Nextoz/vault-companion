# ADR-0069 — Ring analysis: coverage and sleep timing (HC5)

Status: **Accepted** (Lead, 2026-10-29), within candidates #7 and #2 released by the owner on 2026-10-28.
Extends ADR-0068's derived daily schema and read surface. Other HC5 candidates stay unreleased.

## Context

HC5 candidates #7 (wear time and coverage) and #2 (sleep timing and regularity) build on ADR-0068's
15-minute slots and derived daily rows. Coverage explains missing results and should be visible first.
The data clock starts at the first stored slot and counts days or nights with data; nights without wear
do not count toward a minimum. Missing stays missing, and nothing here is a diagnosis.

A monthly slot file cost about 16 ms CPU to parse in the 2026-10-28 measurement. Workers Free allows
10 ms CPU per invocation (`docs/deploy.md`); a 30-night analysis must therefore avoid parsing monthly slots.

## Decision

The analysis source is only `Health/Data/Apple Health Vitals Daily.csv`, with one row per Copenhagen date.
Requests never read monthly slot files. This keeps a 30-night analysis within the Workers Free CPU budget;
implementation must verify that budget with synthetic data.

Append `slots_n`, `longest_gap_min` and `sleep_mask` to `RING_DAILY_HEADER` in
`packages/domain/src/ring-metrics.ts`, using ADR-0068's known-header upgrade path only on a changing write.
`slots_n` counts slots with any non-null value on that Copenhagen calendar date. `longest_gap_min` is the
longest run of slots without any value inside that date, multiplied by 15 minutes, including boundary gaps.
`sleep_mask` has one character per slot in instant order: normally 96, or 92/100 on DST dates.
`1` means asleep (positive light or deep sleep minutes); `0` means awake: the slot has at least one reading
(the ring was worn) but no light or deep minutes, because the ring app records stages only inside a sleep
session it detected; `-` means no reading of any metric in that slot. (Lead decision: an awake-stage-only
`0` would leave every daytime slot `-`, so the index could never compare the full 24 hours.)
Ingest computes these fields from the merged slots the daily step already loads, with no extra reads.
The mask describes the calendar date, not the selected night session; ADR-0068's night selection stays intact.

Show #7 coverage first, from one day with data: hours of data per day (`slots_n` × 15 / 60),
hours per available metric (`*_n` × 15 / 60), nights missed (dates with no `sleep_n`), and longest gap.
Use the stored count fields only; absent new cells are unknown, never zero. `sleep_n` retains ADR-0068's
night-session meaning, so its hours describe that session rather than calendar-day wear.
Count missed nights only within the observed date range; no history before the first stored slot is inferred.
Coverage means recorded data, not proof that the ring was worn throughout every counted slot.

For #2, derive each night's bedtime, wake time, midpoint and duration from `sleep_start`, `sleep_end`
and stage minutes, preserving ADR-0068's wake-date/03:00-cut convention. Bedtime and wake time use the
stored endpoints; midpoint bisects their elapsed interval; sleep duration sums light and deep minutes,
with awake minutes shown separately. Missing inputs yield missing outputs.
Show the standard deviation of midpoint and duration over 7 and 14 nights. Midpoint spread and means
unwrap Copenhagen clock times across midnight so adjacent late-night times stay adjacent.
Weekly values require 7 consecutive nights with data; the 14-night spread requires 14 consecutive nights.

Compute the Sleep Regularity Index from consecutive calendar dates' `sleep_mask` values: the share
of eligible slot pairs 24 hours apart with the same sleep/wake state, with `n` (eligible pairs) shown.
Exclude pairs containing `-` (no reading at all); do not infer sleep/wake state from nightly stage totals. Weekly SRI requires
7 consecutive nights with data and eligible pairs; an empty denominator yields no value.
Show weekday versus weekend midpoint shift as the weekend mean midpoint minus the weekday mean midpoint,
using Copenhagen night dates (Saturday/Sunday are weekend). Require 14 nights with data, including at
least 4 weekend nights and weekday observations. Below any minimum show "not enough data yet",
never an estimate; a missed night cannot be silently skipped to satisfy a consecutive-night minimum.

Expose `GET /api/health/ring/analysis` behind user Access authentication and the email allowlist,
with ADR-0039 read guards (1 MB, UTF-8, blob SHA). Read names come from constants only, never client paths.
Compute results in pure `packages/domain/src/ring-analysis.ts`, with no framework, provider or I/O imports.
The UI is a section or sheet under the Health Ring card, with coverage first, neutral colours, no scores,
no good/bad wording and no thresholds. Label the results as observations, never diagnoses.
Values never enter logs, error diagnostics, commit messages, AI models (including Jev), or fixtures;
all examples and tests are synthetic. Existing operation IDs, CAS, trailers and dedupe govern ingest writes.

## Alternatives

- Compute from slot files per request: rejected because monthly parsing already exceeds the Free CPU budget.
- Compute client-side from raw slots: rejected because fetching months adds bandwidth and server parsing CPU, even though values are already viewed on the device.
- Store analysis results in the vault: rejected because it duplicates derived data and creates stale results.
- Derive SRI from stage minutes only: rejected because totals cannot express the published same-state-at-24-hours definition.

## Consequences

- The first changing daily write after the schema bump rewrites the header once and appends empty cells to old rows.
- Old rows retain empty new cells until a send touches their date; dependent results show "not enough data yet". No read-time backfill occurs.
- DST dates have 92/100-character masks. Across a DST day, SRI pairs align by local clock-time slot; unmatched slots are excluded. Repeated clock-time slots pair in occurrence order, without reusing a slot.
- Coverage and sleep analysis add no vault analysis-result file and no extra ingest reads. Implementation must verify CPU, missing-data minimums, header upgrades and DST pairing with synthetic cases.
