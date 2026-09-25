# F3 report — queue/view fixes from the Phase 1 gate rerun

Branch `agent/queue-rerun-fixes`. Fix commit `f4998bf`. Only `apps/web/**` and this report changed. The wire
contract is unchanged, and so is the IndexedDB version: the one new field is optional on stored rows.

## Summary

| ID | Fix | Files |
|---|---|---|
| N2 (Astra) | `PendingRecord.dependencyGeneration` (optional; absent ⇒ 0). `retry(predecessor)` increments it on **every** dependent, including one leased by another tab. It resets a dependent's state only when that dependent is in attention and not leased. `#settle`: an `attention` outcome whose claim was sent under an older generation is requeued (`pending`, attempts 0, no error) behind the predecessor rather than becoming final. The existing `claimId` check still drops replies from expired claims. The body is never touched. | `queue/db.ts`, `queue/queue.ts` |
| N3 (Astra) | (1) `ReadSequencer` in `reads.ts`: `App.refreshTasks` takes a ticket before each read and drops any response (of any kind) older than the newest one already applied. (2) `knownCommits`: every retained receipt is asked about in `known=`, acknowledged or not. Unacknowledged come first, and the list is capped at the Worker's 50. (3) `buildView`: an item counts as reflected **only** if the rendered response's `known` says `included`. The `acknowledged` flag is no longer used there; it only permits eviction. | `reads.ts`, `ui/App.tsx`, `view.ts` |
| N5 (Opus) | `postCommand` passes `signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS)`, with 30 s < `LEASE_MS` 60 s. `#attempt` maps a `TimeoutError`/`AbortError` to `retry` with code `timeout`. The flush loop then goes on to later items. | `api.ts`, `queue/queue.ts` |

## Failing-first tests (all in `apps/web/src/queue/queue.gate.test.ts` unless noted)

Each test was written and run red against the unfixed code before its fix. The unfixed run had 5 failed and 27 passed. The same-generation control passed, as intended.

- **N2** `the Undo's late refusal is not final…`: two queues over one fake-indexeddb database with shared locks. C gets `refused:structure`. U goes out in tab A and its reply is held. Tab B retries C, and C commits. U's held `conflict:task-changed` is then released. Expected: U is requeued and resent with identical bytes; both receipts are stored and nothing is pending.
- **N2** `after lease expiry and reclaim…`: A's lease on U expires and B reclaims U, with both replies held. A's late refusal is ignored (claimId). A retries C, which commits; U is leased by B at that moment, so it is only marked. B's refusal is then requeued, and U is sent once more. All U bodies are byte-identical.
- **N2** control `a refusal from the same generation is still final`.
- **N3** `R0 → C → R1 (acknowledges) → late R0`: the sequencer rejects the late R0, and the rendered R1 shows the server Done row. `buildView(R0)` shows the saved overlay and no open row. On the old code it showed 1 open row and 0 Done rows, which is Astra's reproduction.
- **N3** `reload variant`: C is saved and acknowledged, then the queue is disposed and reopened. `knownCommits` still asks about C. A stale read that says `not-included` shows the overlay, and a fresh read shows the server row.
- **N5** `is aborted before the lease expires…`: real `postCommand` against a stubbed fetch that never settles except by abort, with `AbortSignal.timeout` spied. It asserts the call uses `COMMAND_TIMEOUT_MS`, which is < `LEASE_MS`. After the abort, the first item is pending with attempts 1 and `timeout`, and the second capture was sent and settled in the same flush.
- `view.test.ts`: the old test asserting the sticky acknowledgement (A9) is replaced by one asserting N3 semantics. `reads.test.ts` is new and covers sequencer ordering and `knownCommits` order/cap.

## Verification

- `pnpm lint`: pass. `pnpm typecheck`: pass.
- `pnpm test`: **416 passed / 27 files**.
- `pnpm --filter @vault-companion/web e2e`: **8 passed** (iphone-15-webkit).

## Mutation checks (one at a time, in the foreground, each reverted with `git checkout`)

| Mutant | Killed by |
|---|---|
| settle ignores the generation (`if (false)`) | both N2 tests |
| retry does not mark leased dependents | both N2 tests |
| view restores `i.acknowledged \|\|` | view N3 test, gate R0 test, reload variant |
| `knownCommits` omits acknowledged receipts | reads test, reload variant |
| sequencer accepts every response | reads test, gate R0 test |
| `postCommand` without an abort signal | N5 |
| timeout not classified (falls to `network`) | N5 |

An earlier attempt ran all mutants in one background script. It ended without output, which the Lead attributed to memory pressure. Afterwards I checked every mutated line and all were in their original form. The whole set was then rerun in the foreground as above.

## Limitations / notes for the Lead

- The `App.tsx` wiring is not covered by unit tests, because there is no React test harness. That wiring is: take a ticket before `getTasks`, drop non-newest responses, and acknowledge only accepted responses. The logic it calls (`ReadSequencer`, `knownCommits`, `buildView`) is covered and mutation-checked.
- Read ordering is per tab and in memory. Across a reload, protection comes from retained receipts plus rendered-`known` reflection. Once an acknowledged receipt is evicted (more than 20 acknowledged), a stale replica read could still show pre-commit state for that action. There is no revision watermark, because commit SHAs are not ordered without an ancestry check.
- A requeued N2 dependent also comes back if its old-generation refusal was unrelated to the predecessor. It will just be sent once more, which is harmless because the service deduplicates.

F3 DONE f4998bf — docs/briefs/F3-report.md
