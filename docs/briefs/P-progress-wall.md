# Brief P — Progress Wall inside History (Claude Code Cloud, branch agent/progress)

**Push early:** within the first minutes create `.agent/handoffs/P-progress-wall.md` with a one-line stub, commit it on
branch `agent/progress` and push; push again at each stable point and at the end. Do not open a PR or spawn agents.

**Base:** create `agent/progress` from `origin/agent/t2` (PR #41, merging first: it adds the `attended` decision and
`outcome` that Progress counts), not from `main`.

Contract: `docs/decisions/0027-progress-wall.md` (read fully). Follow AGENTS.md (non-negotiables + worker token
economy). Synthetic fixtures only. Commit in logical steps.

## Files (use `rg -n`, then line windows)
- web: `apps/web/src/ui/App.tsx` (tab label History → Progress), the History view component (`rg -ln "History" apps/web/src/ui`),
  `apps/web/src/api.ts` (`getHistory`, `getTraining`, `getTriage`, `getNotes`), `apps/web/src/training.ts`
  (`trainingSummary`, units parsing), `apps/web/src/triage.ts` (`deriveTriage`: effective decisions), `apps/web/src/styles.css`
- contracts/worker for the one server change: `packages/contracts/src/index.ts` (`TriageResponse` decisions),
  `packages/domain/src/triage-format.ts` (decision line parse), `apps/worker/src/app.ts` (`/api/triage`) + triage tests
- e2e: `apps/web/e2e/history.spec.ts` (or the spec covering History), `apps/web/e2e/mock-api.ts`

## Build
1. Server: add `title`, `start` (from the stored `card`) and `outcome` (attended only, else null) to each `/api/triage`
   decision entry. Old decision lines without them parse with `title: null`/`start: null`. Test both.
2. `apps/web/src/progress.ts` (pure, unit-tested): `weekOf(date)` (Copenhagen Monday), `progressWeeks(inputs, today,
   weeks = 8)` returning per week: tasks, activeWork, runs {count, km}, gym {count, splits}, events {go, attended},
   notes — each with its evidence items; an input source may be `null` (unavailable) and is marked so.
   Effective triage decisions = latest non-undone per event (reuse `deriveTriage`'s logic, do not duplicate it).
3. `apps/web/src/ui/Progress*.tsx`: "This week" card (summary line + expandable evidence lists), "Earlier weeks"
   (7 collapsed week lines, tap to expand), then the existing day list unchanged. Tab label "Progress". Wording per
   ADR-0027: no streaks, targets or comparisons. 390 px, no horizontal page scroll, tap targets ≥ 44 px.
4. Tests: unit tests for week boundaries (Sunday 23:30 vs Monday 00:30 Copenhagen, a DST week), km totals with legacy
   unit-less and `5.2 km` values, undone decisions excluded, a null source. e2e (WebKit iPhone, mock API): Progress
   tab shows this week's summary line with the right counts, expanding shows evidence, an earlier week expands, a
   failed training read shows "Training unavailable" while the rest renders, existing History e2e still passes.

Every guard needs a test that fails when reverted (mutation-check week boundary and undone-exclusion).

## Checks (targeted only)
`pnpm exec vitest run <touched test files> --reporter=dot`; `pnpm -r exec tsc --noEmit`; `pnpm lint`.
e2e: write the WebKit spec but do **not** run Playwright (the container has no WebKit; the Lead runs it locally).

## Handoff (≤ 15 lines) in `.agent/handoffs/P-progress-wall.md` (committed and pushed)
What you built, test counts, deviations and why. Last line `PROGRESS DONE` or `PROGRESS BLOCKED: <reason>`.
