# P — Progress Wall (branch agent/progress, based on origin/agent/t2)
- Server: `/api/triage` decisions now carry `title`/`start` from the stored card (outcome was already attended-only via T2's refine).
  Contract defaults both to null, so pre-ADR-0027 responses still parse. Domain test covers both (packages/domain/src/triage.test.ts).
- `apps/web/src/progress.ts`: `weekOf` (Copenhagen calendar Monday; instants go through `copenhagenDay`), `progressWeeks`,
  `weekSummary`, `unavailable`, `weekRange`. Undo handling reuses a new `effectiveDecisions()` extracted from `deriveTriage` (triage.ts).
- UI: tab label "Progress"; `ui/Progress.tsx` = This week card (summary + "Show what happened" evidence) → Earlier weeks
  (7 collapsed rows, tap to expand) → "Day by day" + the unchanged History list. History now receives its read from Progress (one fetch).
  Notes open in place via the exported `NoteScreen`; task wikilinks open through the existing linked-note viewer.
- Tests: progress.test.ts 8 (Sun 23:30 / Mon 00:30, both DST weeks, km with `5`/`5.2 km`/`4.4km`, undone excluded, null source);
  mutation-checked: UTC boundary, 7×24 h weeks, undone not excluded each fail. Targeted vitest 85/85 across 8 files; `tsc -b` and lint clean.
- e2e: new `e2e/progress.spec.ts` (2 tests) + mock `trainingMode: 'error'`; history/draft/training specs updated for the "Progress" label.
  NOT run (no WebKit here, per brief) — Lead please run `progress.spec.ts`, `history.spec.ts`, `draft.spec.ts`, `training.spec.ts`.
- Decisions: an event counts in the week of its `start` (falls back to decision `at` for legacy entries); `missed` is not counted;
  events line = "N events (M attended)"; earlier empty weeks say "Nothing recorded". Decisions only cover the current + previous month
  (existing server window), so weeks older than that show no events — acceptable for v1, flagged for the Lead.
- ADR-0027 lives on main, not in agent/t2; I did not merge main into this branch.
PROGRESS DONE
