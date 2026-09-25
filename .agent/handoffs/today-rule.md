# Today rule

## Completed

- Added exported pure `classifyOpenTask(view, today)` in `packages/domain/src/commands.ts`, following the six ordered rules in the Today product contract. Non-open tasks return `other`.
- Routed the tasks read's Today and Overdue filters through the classifier; other response fields and All open behavior are unchanged.
- Added `packages/domain/src/today-rule.test.ts`: 20 synthetic signal/date combinations, the same 20 cases with done status, and one real `InMemoryStore` tasks-read test. Today is fixed at 2026-09-25.

## Important discoveries

- The checkout's Today contract matches `git show origin/main:docs/product-contract.md`.
- The previous rule included start-only tasks and allowed priority or past scheduled dates to bypass future availability dates.
- No web test failed; no changes to `apps/web` were needed.

## Recommend

- Lead reviews and commits this bounded change. No new product decision or follow-up is required.

## Verification

- Targeted new test file: 41 passed.
- Mutation proof: temporarily replaced the classifier with the old rule (due/start/scheduled <= today or unconditional high/highest priority, with overdue first). Six tests failed: past start only, start today only, high future start, high future scheduled, past scheduled future start, and the real tasks-read integration test. Test command exited 1; the correct implementation was restored in `finally`.
- After restoration: `pnpm lint` passed; `pnpm typecheck` passed; `pnpm test` passed (29 files, 495 tests).
- `git diff --check` passed. Dependencies were not installed. No live/reference vault was accessed or written.

## Commit

none, Lead commits

TR DONE
