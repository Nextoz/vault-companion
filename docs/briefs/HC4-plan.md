# HC4 build plan (Opus planning pass, 2026-10-28)

Inputs: `docs/briefs/HC4-ring-slots.md`, ADR-0068 (both amended in this pass), owner entries of 2026-10-28.
Patterns: `packages/domain/src/health-ingest.ts` (strict parse, `bodyShape`, CSV merge keeping raw lines + EOL/BOM,
`executeWrite` with `health-ingest:<hash32>`), `apps/worker/src/app.ts` (`/api/*` exemption, ingest route shape).

## Module boundaries (domain stays pure: no React/Hono/Cloudflare/GitHub)

| Slice | Files | Owns |
|---|---|---|
| a1 | `domain/src/health-format.ts` | `roundHalfEven`, `formatNumber`, `splitCsvLine`, `weekday`, `wallClockDate` moved verbatim from `health-ingest.ts`; v1 imports them (its exact-byte tests guard the move); not re-exported |
| a1 | `domain/src/ring-metrics.ts` | registry, schema versions, slot header per version, daily header |
| a1 | `domain/src/ring-slots.ts` | `parseRingPayload(body, now, tz)`, `canonicalSlotStart(ms, tz)`, `slotMonth(ms, tz)`, `splitByMonth` |
| a2 | `domain/src/ring-slot-file.ts` | `parseSlotFile`, `mergeSlotFile(text or null, slots, version)` -> `{text, changed}` or refusal |
| a2 | `domain/src/ring-daily.ts` | `findSessions`, `affectedDates`, `deriveDailyRow(date, slots, tz)`, `mergeDailyFile` |
| b | `domain/src/ring-ingest.ts`; contracts `RING_SLOTS_DIR`, `HEALTH_VITALS_DAILY_CSV`, `ringSlotsPath(month)`; `app.ts` route + exemption; `worker/src/index.ts` wiring | <= 3 sequential `executeWrite`, statuses, response contract |
| c | `domain/src/ring-read.ts`; `health.ts` `vitals`; contracts response types; `app.ts` GET | day slots + night, `null` kept |
| d | `apps/web` day sheet + Health "Ring" section | strips from registry (option A), lazy-loaded |

## Registry shape (`ring-metrics.ts`)

```ts
type RingValueRule = { kind: 'int'; min: 0; max?: number } | { kind: 'decimal'; decimals: 2; min: 0 };
interface RingDailyAgg { column: string; scope: 'day' | 'night'; fn: 'mean' | 'min' | 'median' | 'sum' | 'count'; decimals: 0 | 1; minCount?: number }
interface RingMetric {
  key: RingKey; column: string; unit: 'count' | 'bpm' | '%' | 'mmHg' | 'ms' | 'degC' | 'min' | 'score';
  value: RingValueRule; since: number; sumGroup?: { id: 'sleep'; max: 15 }; daily: readonly RingDailyAgg[];
  strip: string; chart: 'line' | 'band-low' | 'band-high' | 'bars' | 'stage' | 'dots'; colour: `ring-${string}`; labelUnverified: boolean;
}
export const RING_METRICS: readonly RingMetric[];   // order = CSV column order after slot_start
export const RING_SCHEMAS: Readonly<Record<string, number>> = { 'ring-slots/1': 1 };
export function ringSlotHeader(version: number): string;
export const RING_DAILY_HEADER: string;             // ADR literal
```
Fixed daily columns (`date, weekday, sleep_start, sleep_end, sleep_n`) live in `ring-daily.ts`; all others come from
`daily` entries (hr: `avg_hr` day/mean/0, `hr_n` day/count, `resting_hr` night/median/0/minCount 3). Unverified:
fatigue, stress, hrvMs. Colour is a token name only.

## Tests per invariant (each fails when its guard is removed; slots built in code, sentinel values like 987)

- null never erases / re-send no commit / untouched bytes: `ring-slot-file.test.ts` (stored 72 + send null -> 72;
  same slots twice -> `changed:false`; neighbour rows exact bytes with CRLF + BOM; equal value -> row not rewritten);
  `ring-ingest.test.ts` (same body twice -> no new write).
- DST: `ring-slots.test.ts` (`2026-10-25T02:15:00+02:00` and `...02:15:00+01:00` both kept, canonical strings differ;
  `2026-10-25T02:15:00+01:00` + `2026-10-25T01:15:00Z` -> 422 duplicate); `ring-slot-file.test.ts` (same instant in
  another offset merges into the stored row, never appended).
- Two months: `ring-slots.test.ts` (split Oct 31/Nov 1); `ring-ingest.test.ts` (both files written; store fails write
  2 or 3 -> error names file kind; re-send commits only the missing writes).
- Refusals: `ring-slots.test.ts` table (`:07`, `:15:30`, fraction, > 8 days, after `generatedAt`, duplicate, unknown
  key, missing key, all-null, string number, negative, 1.5 as int, tempC 3 decimals, sleep 16, sleep sum 16, wrong
  schema, empty/long device, future `generatedAt`) -> 400/422, `error` names slot index + key, never the sentinel.
- Missing stays missing: `ring-daily.test.ts` (no hr -> `avg_hr` empty + `hr_n` 0; no slots -> no row, older row
  survives); `ring-read.test.ts` (`null` in JSON); HC4-d (gap breaks the path, no 0 point).
- Night rules: `ring-daily.test.ts` (4 empty slots join, 5 split; longest wins, tie later; wake 02:00 -> previous
  date; night across Oct/Nov; resting HR 2 slots -> empty, 4 slots -> even median half-even; awake-only = sleep slot).
- v1 unchanged: existing exact-byte cases in `domain/src/health-ingest.test.ts` (a1) + golden request (b).
- Privacy/response: `ring-ingest-wiring.test.ts` (log spy has no sentinel; 400/401/404/409/413/422/503 -> `ok:false`
  + `error`; 200 has no `error` key).

## Docs changed in this pass

ADR-0068: night date = date of `sleep_end` - 3 h; sleep slot = light+deep+awake > 0; session gap <= 75 min between
starts; longest-session tie rule; `resting_hr`/`sleep_n` slot scope; calendar date for day values; even median;
affected dates + previous-month read; `start` seconds/offset/instant uniqueness, not after `generatedAt`; `tempC`
non-negative; 400 vs 422; success body; cell formatting; malformed stored row -> 409; metric registry +
schema/header-upgrade rule (resolves "other header refused" vs "columns append"); op-ID hash 32 hex; plans merge at
their CAS commit. Brief: gate 3 done; HC4-a split a1/a2 with file names; HC4-d design A + DST axis; link here.

## Open questions (Lead/owner)

1. `generatedAt` is bounded only in the future; an old body replay is accepted (harmless under non-erasing merge).
   Optional: require it within 24 h of now.
2. `tempC` negative (if the fork sends a delta) -> 400 today; a registry change.
3. Duplicate JSON keys in one slot are invisible after `JSON.parse` (v1 has the same limit).

## Risks

- a1/a2 size: keep tests table-driven; split at 400 lines. Copenhagen maths via `Intl` only; test both DST changes.
- HC4-b daily plan must read slot files at its CAS commit, else a retry cannot repair.
- Daily rows are replaced whole: hand edits on a re-derived date are overwritten (derived file, accepted).
- HC4-d: 23/25-hour axes; registry import only in the lazy day sheet (bundle size).

---

# Worker brief HC4-a1 (then a2 with the delta below)

Read `AGENTS.md` (worker token economy), then only: ADR-0068 sections **Payload**, **Metric registry**, **Storage**
(`rg -n "^\*\*" docs/decisions/0068-ring-slots.md` for line windows); the "Registry shape" and "Tests" sections above;
`packages/domain/src/health-ingest.ts` lines for `parseIso`, `bodyShape`, `wallClockDate`, `roundHalfEven`,
`formatNumber`, `splitCsvLine`, `weekday` (`rg -n` them). Synthetic data only; no I/O; no other files.

Branch `feat/hc4-a1-ring-parse` from `main`. Commit `docs/briefs/HC4-ring-slots.md`, `docs/briefs/HC4-plan.md`,
`docs/decisions/0068-ring-slots.md` (untracked) in this PR.

Do:
1. `packages/domain/src/health-format.ts`: move the five helpers verbatim from `health-ingest.ts`; import them there.
   No logic edits to v1. Do not re-export from `index.ts`.
2. `packages/domain/src/ring-metrics.ts`: the registry above, 14 metrics in ADR CSV order (payload key -> column:
   steps, hr, hrMin/hr_min, hrMax/hr_max, spo2, bpSys/bp_sys, bpDia/bp_dia, fatigue, stress, hrvMs/hrv_ms,
   tempC/temp_c, sleepLightMin/sleep_light_min, sleepDeepMin/sleep_deep_min, sleepAwakeMin/sleep_awake_min), all
   `since: 1`; sleep minutes `max: 15` + `sumGroup` sleep; `RING_SCHEMAS`, `ringSlotHeader`, `RING_DAILY_HEADER`.
3. `packages/domain/src/ring-slots.ts`: `parseRingPayload(body: string, now: Date, timeZone = DEFAULT_USER_TIME_ZONE)`
   -> `{ ok: true; version; slots: RingSlot[] }` (`RingSlot = { instant: number; values: Record<RingKey, number | null> }`,
   sorted by instant) or `{ ok: false; status: 400 | 422; error }`. Rules exactly as ADR **Payload** (validation is
   driven by the registry for the payload's version, never a hand list). Errors name `slot <i>` and the key only; on
   400/422 append `bodyShape(body)` like v1 (export it or reuse). Plus `canonicalSlotStart(instant, tz)` ->
   `YYYY-MM-DDTHH:MM:00+HH:MM` and `slotMonth(instant, tz)` -> `YYYY-MM`, `splitByMonth(slots, tz)` (oldest first).
4. `packages/domain/src/index.ts`: export the two ring modules.

Tests (new): `packages/domain/src/ring-metrics.test.ts` (v1 header == ADR literal; daily header == ADR literal;
registry daily columns + fixed columns == daily header set; keys unique; unverified set = fatigue, stress, hrvMs);
`packages/domain/src/ring-slots.test.ts` (the refusal table, DST and month-split cases above; empty `slots` -> ok
with 0; canonical string for both DST offsets; sentinel 987 never in `error`). Build slots with a helper in the test.

Acceptance (worker runs only these):
```
pnpm exec vitest run packages/domain/src/ring-metrics.test.ts packages/domain/src/ring-slots.test.ts packages/domain/src/health-ingest.test.ts --reporter=dot
pnpm -r exec tsc --noEmit
```
Done = both green, diff <= 400 changed lines (tests included; docs excluded), `health-ingest.test.ts` untouched.
Handoff <= 15 lines: files, line count, any ADR ambiguity hit (do not guess: stop and report).

**a2 delta** (branch `feat/hc4-a2-ring-merge`, after a1 merges): `ring-slot-file.ts` (+test) per ADR **Storage**
(merge by instant, null never erases, rewrite a row only on change, keep EOL/BOM/order, header must equal a known
version header else refusal `refused:structure`, malformed stored row -> refusal; absent -> header + rows);
`ring-daily.ts` (+test) per ADR **Derived daily row** (sessions, night, day values, `affectedDates`, row formatting
with `roundHalfEven`, `mergeDailyFile` like v1 `mergeCsv`). Same acceptance pattern with the two new test files.

---

## HC4-c/d API contract

Lead decision 2026-10-28 (ADR-0068 **Read** leaves the shape open). Zod in `packages/contracts/src/index.ts`, after
`HealthHistoryResponse`; types via `z.infer`. Contracts cannot import `domain` (domain depends on contracts), so slot
values are a record keyed by the registry's payload key; the server always emits **every** `RING_METRICS` key
(`null` when the cell is empty or the column predates the file's schema), and `ring-read.test.ts` asserts the key set
equals the registry. A new metric is then a registry entry only; the day view iterates `RING_METRICS`.

```ts
export const RING_DAILY_CSV = 'Health/Data/Apple Health Vitals Daily.csv'; // if HC4-b has not added it
const slotStart = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/); // canonical slot_start
const count = z.number().int().nonnegative();
/** One derived daily row (ADR-0068), cells verbatim; an empty cell is null. `date` = night date for sleep cells. */
export const RingDailyRow = z.strictObject({
  date: z.iso.date(),
  sleepStart: slotStart.nullable(), sleepEnd: slotStart.nullable(),
  lightMin: count.nullable(), deepMin: count.nullable(), awakeMin: count.nullable(),
  restingHr: z.number().nullable(), avgHr: z.number().nullable(),
  minSpo2: z.number().nullable(), avgSpo2: z.number().nullable(),
  hrvSdnnMs: z.number().nullable(), bodyTempC: z.number().nullable(),
  hrN: count, spo2N: count, hrvN: count, tempN: count, sleepN: count,
});
/** `vitals` on GET /api/health: newest daily row at or before today (Copenhagen). */
export const RingVitals = z.strictObject({
  status: HealthStatus,                 // missing = no daily file or no row; unreadable = guard/parse failure
  row: RingDailyRow.nullable(),         // non-null only when status is ok
  daySlots: z.union([z.literal(92), z.literal(96), z.literal(100)]).nullable(), // slots in row.date (DST aware)
  staleDays: count.nullable(),          // today minus row.date
});
// HealthResponse gains: vitals: RingVitals.optional()  (optional: cached v1 copies still parse)

export const RingSlot = z.strictObject({
  start: slotStart,                                        // as stored; the instant is Date.parse(start)
  values: z.record(z.string(), z.number().nullable()),     // every RING_METRICS key, null kept as null
});
/** GET /api/health/ring?date=YYYY-MM-DD (date required; malformed or after today -> 400 { error }). */
export const RingDayResponse = z.strictObject({
  revision: commitSha, now: isoInstant,
  today: z.iso.date(),                  // Copenhagen; drives "Today" and disables "next" past it
  date: z.iso.date(),
  status: HealthStatus,                 // missing = no month file or no slot on that date
  dayStart: slotStart, dayEnd: slotStart, // local 00:00 of date and of date+1: the axis spans 23/24/25 h
  daySlots: z.union([z.literal(92), z.literal(96), z.literal(100)]),
  slots: z.array(RingSlot),             // stored slots of that calendar date only, ascending, no padding
  night: RingDailyRow.nullable(),       // the daily row whose date === date, else null
  prevDate: z.iso.date().nullable(),    // nearest earlier date with a stored slot (this month, else previous month file)
  nextDate: z.iso.date().nullable(),    // nearest later date with a stored slot, never after today
});
```

Rules: missing slots are absent from `slots` (the client draws gaps); the server never fills, pads or interpolates.
Reads use names built from the validated date only (month file, at most the adjacent month file for prev/next, and
the daily file), ADR-0039 guards; logs carry commit SHA and error code only. Day view join rule (HC4-d, owner
2026-10-28): `hr`/`hrMin`/`hrMax`/`steps` join adjacent slots only; every other line/dots metric joins readings at
most 2 slots apart; a longer gap breaks the line. Stress and fatigue share `strip: 'score'` in the a1 registry but
are separate strips in design A: HC4-d1 sets their `strip` to `'stress'`/`'fatigue'` (view-only field).
