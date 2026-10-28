# HC4-d worker briefs: Ring day view (design A "stacked strips"), after HC4-c merges

# HC4-d1: Ring section, day sheet shell, nav, axis, HR/SpO2/steps/sleep strips

Read `AGENTS.md` (token economy), then only: `docs/briefs/HC4-plan.md` "HC4-c/d API contract"; `docs/mockups/2026-10-28/
ring-day-view-A.html` (+ `.png`, behaviour notes at the bottom); `packages/domain/src/ring-metrics.ts`; `HealthPanel.tsx`;
`SheetHeader.tsx` (`onBack`); `TrainingSheet.tsx` line 54; `e2e/health-history.spec.ts`; `rg -n health e2e/mock-api.ts`.
Synthetic data built in code only. Branch `feat/hc4-d1-ring-day` from `main`; <= 400 changed lines (docs excluded).

## Outcome
- Health card (`HealthPanel.tsx`) gets a "Ring" section from `health.vitals`: last night asleep (light+deep, `7 h 12`),
  resting HR, HRV `(unverified)`, coverage `hrN / daySlots slots`; `—` for null; missing/unreadable -> one muted line.
  A "Ring day ›" button opens the sheet for `vitals.row.date`. No registry import here (bundle: card stays small).
- `RingDaySheet.tsx` is `lazy()`-loaded from `HealthPanel.tsx` (pattern: `App.tsx` line 57, `Suspense` "Loading…"),
  `role="dialog"`, title "Ring day", `SheetHeader` with `onBack` + `backLabel="Health"` (closing returns to the card),
  a "Today" button, and a day nav "‹ Tue 28 / Wednesday 29 Oct / Thu 30 ›" using `prevDate`/`nextDate` (disabled when
  null). Each move fetches `getRing(date)` (`apps/web/src/api.ts`, parses `RingDayResponse`).
- One shared axis from `dayStart` to `dayEnd` by instant (x = (Date.parse(start) - dayStart) / (dayEnd - dayStart));
  labels every 3 h on local wall-clock hours, so DST days show 23 or 25 hours. `status: 'missing'` -> "No ring data
  for this day." with nav still working. Handoff <= 15 lines.
- Strips built from `RING_METRICS` grouped by `strip` (stage strip first, then registry order); d1 renders the
  `sleep`, `bpm` (HR line + `hrMin`-`hrMax` band), `%` and `count` strips via `D1_STRIPS` (d2 deletes the filter).
  Sleep = stacked stage band (deep/light/awake legend). Steps = bars; null = no bar (0 = zero-height bar is fine).
  Join rule from the contract: HR/steps adjacent slots only, others <= 2 slots apart; longer gap breaks the path;
  isolated readings draw a dot; never a point for null, never interpolated. Neutral colours: add `--ring-<column>`
  tokens to `apps/web/src/tokens.css`; no thresholds or good/bad colour.
- `packages/domain/src/ring-metrics.ts`: `strip` of fatigue/stress -> `'fatigue'`/`'stress'` (view-only field).

Owned (under `apps/web/`): `src/ui/HealthPanel.tsx`, `src/ui/RingDaySheet.tsx` + `src/ui/RingDay.css` (new),
`src/ui/ring-day.ts` (new, pure: axis, scales, `ringSegments(values, maxGapSlots)`, strip grouping, formatters),
`src/tokens.css`, `src/api.ts`, `e2e/mock-api.ts` (`vitals` on health; per-date `ring` fixture from a seeded sin hash
as in the mockup, one 4-slot gap, a 100-slot `2026-10-25`; `ringReads`), `e2e/ring-day.spec.ts` (new); plus
`packages/domain/src/ring-metrics.ts`. Tests: `src/ui/ring-day.test.ts` (new), `src/ui/HealthPanel.test.ts` (extend).

## Acceptance
- `ring-day.test.ts`: gap of 3 slots breaks a SpO2 path, gap of 2 joins it, HR gap of 1 breaks; null slot yields no
  point and no y=0; 2026-10-25 (100 slots) places `02:15+01:00` at 13/100 of width and labels a repeated 02 hour;
  strips derive from `RING_METRICS` (a fake extra registry entry yields an extra strip).
- `HealthPanel.test.ts`: Ring section shows the four summary values, `—` for null, no section when `vitals` absent.
- `ring-day.spec.ts` at 390x844: Log -> Health -> "Ring day ›" opens the sheet (`ringReads` 0 before), prev/next
  changes the heading + fetches once, next disabled at `today`, "‹ Health" returns to the card, a gap breaks the path.
- `pnpm exec vitest run apps/web/src/ui/ring-day.test.ts apps/web/src/ui/HealthPanel.test.ts packages/domain/src/ring-metrics.test.ts --reporter=dot`;
  `pnpm typecheck`; `pnpm --filter @vault-companion/web exec vite build && pnpm --filter @vault-companion/web exec playwright test e2e/ring-day.spec.ts`.

# HC4-d2: remaining strips, scrub readout, night summary, unverified notes, tour shots

Read the same files plus d1's `RingDaySheet.tsx`, `ring-day.ts`; `apps/web/e2e/tour.spec.ts` lines 95-105 and 315-325.
Branch `feat/hc4-d2-ring-day` from `main` after d1 merges. Diff <= 400 changed lines.

## Outcome
- Delete `D1_STRIPS`: every registry strip renders (BP `mmHg` sys+dia dots, stress, fatigue, HRV, temperature).
- Tap or drag (pointer events) across the strips moves a dashed scrub line to the 15-minute slot under the finger;
  Left/Right arrows move it one slot (focusable strips group, `aria-label="Ring strips"`). Each strip header shows the
  selected slot's value. A "Selected slot" card (`role="group"`, title "14:30 – 14:45") lists all 14 registry values
  with units (`—` for null or for a slot absent from `slots`), BP shown as `118/76`. Default selection: last slot with data.
- Night card at the top from `night`: "Night 23:40 – 06:52", asleep, resting HR, HRV (unverified), deep, temp
  (`bodyTempC`, label "temp (day avg)"), coverage "`slots with any value` / `daySlots` slots with data".
- "(unverified)" on every `labelUnverified` strip and tile, plus the note "— = no reading. Fatigue, stress and HRV
  labels are unverified on this ring." No good/bad wording or colour.
- Commit `docs/mockups/2026-10-28/ring-day-view-A.html` and `.png` (untracked today) in this PR.

Owned files: `RingDaySheet.tsx`, `ring-day.ts`, `RingDay.css`, `apps/web/e2e/ring-day.spec.ts`,
`apps/web/e2e/tour.spec.ts`, `apps/web/e2e/mock-api.ts` (fixture tweaks only). Tests: `ring-day.test.ts` (extend).

## Acceptance
- `ring-day.test.ts`: `slotAt(x)` maps to the right slot on 96- and 100-slot days; readout lists exactly the registry
  keys in order with `—` for null; coverage counts a slot with any non-null value, never an absent slot.
- `ring-day.spec.ts` at 390x844: 9 strips visible; clicking at 14:30 on the axis shows "14:30 – 14:45" and the
  fixture's values; ArrowRight moves to "14:45 – 15:00"; the gap slot reads `—` in all 14 rows; "(unverified)" x3.
- Tour shots `Log - Health ring section`, `Log - Ring day`, `Log - Ring day selected slot` (after `Log - Health`).
- `pnpm exec vitest run apps/web/src/ui/ring-day.test.ts --reporter=dot`; `pnpm typecheck`; vite build, then
  `pnpm --filter @vault-companion/web exec playwright test e2e/ring-day.spec.ts e2e/tour.spec.ts`. Handoff <= 15 lines.
