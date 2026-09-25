# F4 report — queue/view fixes from Phase 1 gate run 3

Branch `agent/queue-gate3`. The change is limited to `apps/web/**` and this report. The wire contract is unchanged.

## What changed

### G3-2: Retry is one IndexedDB transaction

- `PendingStore.put(...records)` writes every record in one readwrite transaction. If any write fails, none is kept.
- `PendingQueue.retry` works under the existing `vc-pending` Web Lock. It builds the predecessor reset and every affected
  dependent (generation bump, plus a reset for a non-leased dependent in `attention`). It then commits them with a
  single `#persist(...writes)`.
- `#persist` updates the cache and notifies listeners only after the transaction commits.

### G3-1: shared durable read watermark

- **Schema v3** adds a `meta` store holding `watermark = { commitSha, receiptOpIds, version }`. The upgrade only creates
  missing stores, so v2 pending rows and receipts are kept (tested).
- **Setting it.** Receipts are evicted in two places: the retention rule in `acknowledge(read)` and "Clear saved" in
  `forgetSaved(ids, read)`. Both evict under the lock and write one transaction (`writeReceipts`) holding:
  - the acknowledgements;
  - the removals;
  - `watermark = { commitSha: read.revision, receiptOpIds, version: previous + 1 }`.

  A receipt is evicted only when that same read reports its commit `included`, so the watermark revision contains it.
  Eviction also requires the read to satisfy the current watermark, so the watermark only moves forward.
- **Consistent snapshot.** `#reload` uses `store.load()`: one readonly transaction over `pending`, `receipts` and
  `meta`. `QueueSnapshot.watermark` therefore always matches `items`. If a receipt is missing from the items, a
  watermark at least as new covers it.
- **Accepting a read.** The new `TaskReads` in `reads.ts` does this for each read:
  1. Reads the watermark fresh from IndexedDB.
  2. Asks `known=` about the watermark first, then about retained receipts, up to 50 commits.
  3. When the response arrives, re-reads the watermark from IndexedDB.

  The response is applied only if it satisfies that watermark: `revision === commitSha` or `known[commitSha] ===
  'included'`. If not, the outcome is `stale`:
  - `retry: true` when the request was made before that watermark existed. `App` re-reads, up to 3 times.
  - `retry: false` when the request did ask about the watermark and the answer was `not-included`, for example a
    lagging replica.

  In both cases `App` keeps the last good read and shows "Refreshing…".
- **Rendering.** The applied read records the watermark `version` it was checked against. `renderable(read,
  snapshot.watermark)` blocks a screen that was checked against an older watermark than the one the tab has since
  loaded (the reload variant). `App` then shows "Refreshing…" and reads again.
- **"Clear saved"** now takes the read on screen. It only offers receipts that read reports `included`.

### F3: read ordering is now testable

`App.refreshTasks` now calls `TaskReads.read()`, which contains the sequencer and the watermark check. `App` only acts
on the outcome (`apply`, `superseded`, `stale`, `signed-out`, `offline`, `error`). The accept check lives in
`TaskReads.read`. A test with two held `getTasks` promises (R0 → R1 → late R0) fails if that check is deleted.

## Tests (each written first and seen failing before the fix)

Multi-tab cases use two independently opened queues over one fake-indexeddb database, with shared locks.

| Test | Before the fix |
|---|---|
| G3-2: interruption at the transaction boundary, then restart of B, then A's held U refusal is released; U is requeued and sent, both receipts, no pending | U stuck in `attention` (Astra's state) |
| G3-2: failure inside the transaction (uncloneable dependent) rolls back both, publishes nothing, restart, later Retry works | C committed as `pending` alone |
| G3-1: Astra's scenario (A holds R0; B completes 21, reads, acknowledges, evicts; A `kick`s; R0 arrives) gives `stale`/`retry`; the re-read asks about the watermark and renders nothing open | API absent; R0 accepted |
| G3-1: read that asked about the watermark and reports it `not-included` is `stale` with no retry | — |
| G3-1: reload variant (new queue and same-page `kick`): a read rendered before the eviction is no longer `renderable` | — |
| G3-1: explicit "Clear saved" sets the watermark; A's held R0 is then `stale` | — |
| G3-1: a receipt is evicted only by a read that reports it `included` (retention and "Clear saved" paths) | — |
| G3-1: a read that does not satisfy the watermark can neither evict nor move it | — |
| v2 → v3 upgrade keeps pending rows and receipts | no `meta` store |
| F3: R0 → R1 → late R0 through `TaskReads`; watermark asked first within `MAX_KNOWN` | `TaskReads` absent |

Existing A9/N3 tests were updated to the new `acknowledge(read)` and `forgetSaved(ids, read)` signatures, with the
same assertions.

## Mutation checks

Run one at a time, in the foreground, each against the relevant test files only. The file was restored after each run.

| Mutant | Result |
|---|---|
| Retry writes each record in its own transaction | killed (both G3-2 tests) |
| `#persist` updates the cache before the commit | killed (rollback test) |
| Eviction does not persist the watermark | killed (5 G3-1 tests) |
| Eviction ignores whether the read satisfies the watermark | killed |
| Eviction of receipts the read does not report `included` | first **survived**; killed after adding the "evicted only by a read that reports it included" test |
| `#reload` does not load the watermark | killed (reload variant) |
| `TaskReads` skips the watermark check | killed (3 tests) |
| `TaskReads` does not ask about the watermark | killed (3 tests) |
| `renderable` always true | killed (reload variant) |
| Schema stays at v2 | killed (upgrade test) |
| `TaskReads` accept check deleted | killed (F3 test) |

## Verification

`pnpm lint` and `pnpm typecheck` are clean. `pnpm test` passes: 28 files, 443 tests. `pnpm --filter
@vault-companion/web e2e` passes 8/8 on iPhone 15 WebKit. Playwright uses its configured workers for e2e; every
mutation run was a single sequential vitest process.

## Known limits and notes

- No test renders `App`. The React glue is thin but untested: the switch over `ReadOutcome`, the `fresh` →
  `renderable` gate, and the re-read effect. Ordering and the watermark rules are tested through `TaskReads` and
  `renderable`, which `App` calls directly.
- "Refreshing…" after a `stale`/`retry: false` read stays until the next wake (focus, online, receipt). There is no
  automatic loop against a server that stays behind.
- The single watermark assumes linear, forward-only history, as the brief's design does. A force-push is covered
  separately: `writeBlock`/`dedupe-unknown` paths are outside F4.
- Acknowledged receipts beyond 20 that the current read does not answer about are kept (retention may briefly exceed
  20) rather than evicted without proof.

F4 DONE 5fb564d — docs/briefs/F4-report.md
