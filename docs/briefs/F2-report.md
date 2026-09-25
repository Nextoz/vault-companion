# F2 report: pending-queue fixes from the Phase 1 gate

Branch `agent/queue-fixes`. Scope: `apps/web/**` only. Normative text: `docs/commands.md` → "Client pending queue (PWA)".

## Result

| Finding | Fix | Reproduction test (written first, failed on the old code) |
|---|---|---|
| A3 / R3 multiple tabs | Every decision (claim, Undo/cancel, settle, discard, retry, kick, enqueue, acknowledge) runs inside `navigator.locks.request('vc-pending', …)` after re-reading both IndexedDB stores. A claim writes a durable **lease** (`leaseUntil`, `claimId`, 60 s) so other tabs neither send, cancel nor discard an item in flight. A crashed tab's lease expires. Settle writes a non-receipt outcome only if its `claimId` still owns the record, so a late failure never resurrects or overwrites another tab's settlement. The lock is injectable (`QueueOptions.locks`), and `null` disables local cancellation (Undo always sent). | `queue.gate.test.ts` → "A3 / R3": two queues, each with its own `openPendingStore` connection to one fake-indexeddb database: (a) B sends and settles C, then A's Undo is `queued` and sent; (b) C in flight in B: A's Undo is `queued`, A's Discard is refused, A sends nothing until B settles, then sends the Undo; late failure does not resurrect a settled item; late failure does not overwrite a newer claim; no-locks disables cancellation; with locks, a completion no tab sent is still cancelled. |
| A7 session change mid-claim | Session **generation** (bumped on account change or sign-out). `#attempt` re-checks generation, account and signed-out synchronously, immediately before the request, which is after every await of the claim. On a change the item is released unsent (lease cleared, attempts unchanged) and shows as account-mismatch attention. `postCommand(body, accountKey)` sends `X-VC-Account: <item accountKey>`. `classify` treats `account-mismatch` as attention even if a reply says `retryable`. | "A7": `setSession(B)` injected inside the claim's `put` of `everSent:true` (the reviewer's interleaving); `setSignedOut` at the same point; `setSession(B)` after the claim's lock is released but before the send; header asserted on both the queue callback and `postCommand`'s `fetch` init; 409 `account-mismatch` sent once, never retried. |
| A9 persisted receipts | New store `receipts` (DB version 2). `store.settle()` deletes the pending row and puts the receipt in **one** transaction. The snapshot is rebuilt from both stores, so receipts survive reload. `App` asks `known=` only for unacknowledged receipts and calls `queue.acknowledge(read.known)`. `included` marks a receipt acknowledged. Only acknowledged receipts are evicted (bounded at 20) or cleared by "Clear saved". `buildView` treats an acknowledged receipt as reflected. | "A9": save → reload (new queue) → stale read (`not-included`) keeps the completion in Done today; an uncloneable receipt aborts `settle` and the pending row survives (atomicity); 25 unacknowledged receipts all kept, not cleared by `forgetSaved`, not acknowledged by `not-included`, bounded after `included`. `view.test.ts`: an acknowledged receipt stops overlaying. |
| R4 dependent release | `knownNotApplied()` = `refused:*`, `conflict:*`, `operation-id-reused`, `invalid`, `account-mismatch`. Only these release a `dependsOn` successor **and** same-task FIFO successors; other attention states keep them waiting. `retry(predecessor)` resets its attention dependents to pending, behind it. | "R4": `dedupe-unknown`, non-JSON 418, API `forbidden` keep the Undo waiting; the five releasing codes release it; `dedupe-unknown` holds a dependent without a shared task key (dependsOn alone); holds a same-task item without dependency; Retry on the predecessor re-sends C then U. |
| R12 receipt op ID | `classify(res, operationId)`: a 200 whose receipt names another operation is `retry` (`invalid-response`). | "R12": misrouted 200 leaves the item pending with `attempts: 1` and no receipt; the next attempt settles it. |

## Mutation check

Each guard was broken in turn (scripted), and `vitest run apps/web` was run against it. All 20 mutants were killed:

re-read inside lock · Web Lock taken · no-locks disables cancel · lease blocks claim · lease blocks discard ·
settle ownership (`claimId`) · pre-request session re-check · `X-VC-Account` header · `account-mismatch` final ·
settle is one transaction · receipt persisted · forget only acknowledged · evict only acknowledged · acknowledge
needs `included` · view: acknowledged reflected · dependents need known-not-applied · same-task FIFO on non-final
attention · released code set · Retry resets dependents · receipt op-ID check.

The first run had three survivors, and each led to a change:

- The `claimId` branch of settle survived. Added "late failure does not overwrite another tab's newer claim".
- The R4 `dependsOn` rule survived because it was masked by same-task FIFO. Added the task-key-less dependent test.
- A second session check right after the claim's `put` survived because it is redundant. The synchronous pre-request
  check comes after every await of the claim and compares the same generation, so no interleaving can tell the two
  apart. I removed it: rule 7 requires each guard to have a test that fails when it is broken. The contract's "after
  every awaited step … and immediately before the request" is met by that single check.

## Verification

- `pnpm check` (lint + typecheck + test): 22 files, 340 tests green.
- `pnpm --filter @vault-companion/web e2e`: 8/8 green (WebKit, iPhone 15). New spec: "a second tab never re-sends a
  completion in flight in the first, and Undo is a real command (A3)". It uses two pages in one context, so both
  have real IndexedDB and real `navigator.locks`. The mock holds page A's completion request. Page B opens and wakes
  but sends nothing. A's Undo is queued. After release, exactly one CompleteTask body has been sent, and the log is
  `[CompleteTask, UndoCompleteTask]`. The old code fails this (B re-sends).
- The e2e mock now rejects a POST without the matching `X-VC-Account` with 409 `account-mismatch`, mirroring the
  Worker on `main`, so every e2e spec also checks the header.

## Decisions and residual risks (for the Lead)

- **Lease (60 s)** is not in the brief. I added it because `#inFlight` was per-tab memory, and the decisions it
  protected (discard refused while in flight, no duplicate send, "saving" state) need a durable form to hold across
  tabs. Costs: after a crash mid-request, an item waits up to 60 s. A request slower than 60 s may be re-sent by
  another tab, which server-side dedupe makes safe. `scheduleWake` wakes at lease expiry.
- **Cancellation proof.** Local cancellation happens only when, under the lock, the pending row exists with
  `everSent:false`. An absent row (settled, discarded or cancelled elsewhere) always gives a real Undo, per the
  contract.
- **DB upgrade v1 → v2** adds `receipts`. `onversionchange` closes the old connection so an old tab cannot block the
  upgrade. Rows without `leaseUntil`/`claimId` count as unleased.
- **No BroadcastChannel.** Other tabs refresh their cache on their next locked action, `online`, focus or visibility,
  not live. This affects display only; decisions always re-read.
- **Unacknowledged receipts are unbounded** by design (A9). They shrink as soon as a read reports `included`.
- `forgetSaved` / `acknowledge` are now async (lock + IndexedDB). "Clear saved" appears only for acknowledged items.
- A server `account-mismatch` still offers a manual **Retry** (useful after signing in to the right account). It is
  never retried automatically.
- The contract text in `docs/commands.md` did not need changes.
