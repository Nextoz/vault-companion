MERGE AFTER FIXES

| id | severity | file:line | defect | concrete failure scenario | fix |
|---|---|---|---|---|---|
| P18-1 | High | `apps/web/src/queue/queue.ts:450` | Base refresh is unsafe in the supported fallback without Web Locks; `everSent` can be a stale cross-tab snapshot. | Both tabs load a capture with `everSent=false`. B pauses after its load; A claims, sends and applies commit C, and a task refresh publishes C to shared preferences. B resumes with its stale record, rebases to C and sends the same operation ID with different bytes. `commitsSince(C,C)` excludes the first application, so the server applies a second capture. Controlled reproduction produced two commits and two identical Markdown rows; disabling refresh produced `applied`, then `already-applied`, and one commit. | Disable base refresh when `#locks === null`, or implement an atomic IndexedDB read/check/rebase/claim transaction. Add a two-tab test that pauses after B's load and advances the latest revision after A applies. |
| P18-2 | Medium | `apps/web/src/queue/queue.ts:453`; `apps/web/src/ui/App.tsx:218,245` | Rebasing a completion leaves the toast's Undo target carrying the old envelope. | The task screen/toast uses base R; another tab's newer read makes the first send use S. The toast retains the object minted at R. Undo copies that target verbatim, and draft token filling changes only `targetCommit`. The real service rejects it with non-retryable `invalid: undo target does not match the recorded completion`, because the recorded payload hash includes S. Reproduced against `createCommandService`. | Resolve the target by operation ID from the durable pending/receipt body under the queue lock before creating a sendable Undo; when filling a draft token, use the receipt's exact target envelope too. Never alter an already-sent Undo. Test toast Undo after a first-send rebase against the real hash check. |

Reviewed `origin/main...HEAD`: merge base `89feb2b`, HEAD `9cc0f05`. Missing main PR #16/#17 changes were excluded.

Dedupe: with a stable submitted body/base, the one-page search and head-CAS do not introduce a second-write path. Too many commits, an unknown/non-ancestor base, or an unverifiable replay produce `dedupe-unknown`. Transport failures and exhausted unknown-write retries still produce retryable `upstream-unavailable`, which does not assert “not applied.” P18-1 breaks the client premise by moving the base past its own application.

With Web Locks, reloading under the lock and persisting `body` together with `everSent=true` protects retries, reloads and expired-lease reclamation from another rebase. That protection is absent in P18-1's fallback.

Cache review: production callers supply immutable commit SHAs; listing keys also include directory and recursion mode. Root listings and compare results associate tree SHAs with those commits, and writes parent on the same commit. Clearing either cache only loses cached answers; no stale-tree write path was identified.

A4 dates overlays using the read's timezone/calendar day and continues hiding the completed open row across midnight. The pending/saved-unreflected and DST boundary tests exercise that behavior.

CI A3 diagnosis: a pre-existing timing-dependent rendering race, not a duplicate-row regression introduced by this PR. It does briefly render two real UI rows; calling it a harmless selector ambiguity would be inaccurate.
The task read can already contain the reopened task while `known` answers only the completion C, because the Undo U receipt was unavailable when that read was requested. U remains unacknowledged/unreflected.
At `apps/web/src/view.ts:157`, C being reflected forces the live Undo to get its own row, while the server's reopened row is also retained. The two spans match the strict locator at `apps/web/e2e/app.spec.ts:170-171`; there need not be a second completion or Undo command.
A deterministic `buildView` probe with this input returns two Today rows on both the merge-base implementation and HEAD. The A4 branch is not involved: the latest action is Undo. Thus the reported CI failure is a flake relative to this PR, exposing an existing read/receipt race.
For A3, wait for receipt-aware refresh convergence and then assert exactly one row before visibility; do not replace the locator with `.first()`. Track the transient rendering race separately with a deterministic regression test.

F1–F3 guard sensitivity (PR #15 fixes; source review, no production mutation performed):

- F1, `apps/web/src/view.test.ts:329`: changing the unacknowledged/missing-`known` fallback to `included` makes the expected hidden open row and saved overlay assertions fail.
- F2, `apps/web/src/queue/queue.test.ts:605`: dropping all receipts fails the retained-ID assertion; preserving `acknowledged=true` fails the explicit `false` assertion; failing to fill the token fails the final sent-command assertion.
- F3, `apps/web/e2e/app.spec.ts:692`: removing the warning fails the visible alert's `toContainText` assertion. This spec was run and passed.
- The handoff's separate dedupe mutations F1–F3 are also covered: paged fallback loses the one-page refusal/call assertions; accepting `too-many` or `not-ancestor` fails the refusal and zero-write assertions in `execute.test.ts:102`.

Checks actually run:

- `pnpm check`: **failed**; lint and typecheck passed; **792/793 tests passed, 48/49 files passed**. The sole failure is unchanged `packages/github/src/store-contract.test.ts:245`: Windows `EPERM` creating the synthetic symlink. No production assertion failed there.
- `pnpm --filter web build`: **passed**. The first A3 launch before this build could not start because `dist` was absent.
- `pnpm --filter web exec playwright test -g "A3" --repeat-each 10`: first built Windows/WebKit batch reported **8 passed, 2 failed**, including the reported two-element strict-mode violation at line 171; its teardown stalled and was interrupted after all ten results. A second identical batch completed normally: **10/10 passed**.
- `pnpm exec vitest run packages/domain/src/execute.test.ts packages/github/src/write-budget.test.ts apps/web/src/queue/queue.test.ts apps/web/src/view.test.ts`: **71/71 passed**.
- `pnpm --filter web exec playwright test -g "review O6" --workers 1`: **1/1 passed** (includes F3).
- Read-only Node probes using production modules: no-lock capture race **reproduced two durable effects**, unchanged-base control **one**; stale Undo target **reproduced `invalid`**; duplicate Today rendering **reproduced on merge base and HEAD**.

## Fixes

- **P18-1:** `queue.ts` disables first-send base refresh without Web Locks. The new two-tab test pauses B after loading a never-sent capture, lets A apply and advance the shared latest revision, then verifies B sends identical bytes, receives `already-applied`, and leaves one commit/Markdown row.
- **P18-2:** `undoCompletion` resolves the completion by operation ID from its durable receipt or pending body under the queue lock. Draft token filling also takes the receipt's exact completion envelope. Missing durable targets remain unsendable drafts; existing/sent Undo bodies are preserved. Three integration cases cover the stale toast with a receipt, a pending completion after a lost response, and an already-stored stale draft. Each uses the real `createCommandService` hash check and verifies byte-identical Undo retries with one durable inverse. Tests live in `apps/web/test/queue-pr18.test.ts`; test-only TypeScript project references permit the cross-layer integration.
- **A3:** waits until both receipts are visible in each tab, triggers and awaits a receipt-aware refresh, then asserts exactly one matching task row and its visibility. No `.first()` workaround.
- **Guard sensitivity:** all **4/4 new regressions fail against the original queue**; all three Undo cases reach the real service's `invalid: undo target does not match the recorded completion`. Removing only the no-lock refresh guard also fails P18-1. Production fixes were restored; the focused queue suite then passed **72/72**.
- **Checks:** final `pnpm check` passed lint/typecheck and **796/797 tests (49/50 files)**. Its only failure is the known Windows symlink `EPERM` at `packages/github/src/store-contract.test.ts:245`. An initial test-placement TypeScript error was corrected before this final check. `pnpm --filter web build` passed. `pnpm --filter web exec playwright test e2e/app.spec.ts -g "A3" --repeat-each 10` finished **10/10 passed, exit 0**; after all results, its stalled preview-server teardown required stopping that run's server process. An earlier batch overlapping the full check reported **2 passed / 8 timed out**, including the refresh-response wait with a single row already visible; an isolated single-worker diagnostic passed **1/1**. Logs: `.agent/pr18-fixes-check.log`, `.agent/pr18-fixes-a3.log`, `.agent/pr18-fixes-a3-repeat.log`, `.agent/pr18-fixes-baseline.log`, `.agent/pr18-fixes-mutation.log`.
- **Follow-up only:** fix the underlying transient duplicate Today row when the task read already contains the reopened task but acknowledges C without U. Add a deterministic `buildView` regression for that read/receipt ordering. This rendering race remains outside these fixes.

Changes are uncommitted on `agent/free-budget`; `docs/plan.md` is untouched.
