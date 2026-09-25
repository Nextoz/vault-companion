# Brief F4 — queue/view fixes from Phase 1 gate run 3

Type: **implementation**. Branch `agent/queue-gate3`, worktree `C:\Dev\vault-companion-worktrees\queue-gate3`.

## Objective

Fix the F4 rows of the "Gate run 3" table in `docs/reviews/phase-1-reconciliation.md`. Reproductions:
`docs/reviews/phase-1-rereview2-astra.md` (G3-1, G3-2) and `docs/reviews/phase-1-rereview2-opus.md` (F3). Write each as
a **failing test first**, using two independent queues over one fake-indexeddb database where tabs are involved:

- **G3-2**: `retry(predecessor)` must reset the predecessor and bump or reset every affected dependent in **one**
  IndexedDB readwrite transaction, under the existing Web Lock. Cache updates are published only after commit. Test an
  injected failure at the transaction boundary, then a restart before the held dependent response is released. The final
  state must follow the queued Undo without a manual retry.
- **G3-1**: a shared, durable read **watermark**. Before a receipt is evicted, persist the acknowledged revision it was
  proven `included` in (for example a `meta` record: `watermark = { commitSha, receiptOpIds }`). A tab may render a read
  as authoritative only if that read's `known` shows the watermark commit `included` (always request it in `known=`), or
  if the read was issued after the watermark was set **and** answered it. Otherwise treat the read as stale and keep the
  last good state or show "refreshing". Test Astra's scenario: tab A holds read R0; tab B completes 21 tasks, reads,
  acknowledges and evicts; A reloads state and then receives R0. Also test the reload variant and explicit saved-entry
  removal. Raising the limit of 20 is not a fix.
- **F3**: move `App.refreshTasks` read ordering into a testable unit (hook or plain function) and test the real wiring
  with two held `getTasks` promises (R0 → R1 → late R0), so deleting the `accept` check fails a test.

A DB version bump is allowed if needed; a v2 → v3 upgrade must keep pending rows and receipts.

## May change

`apps/web/**`, `docs/briefs/F4-report.md`.

## Must not change

Everything else. The wire contract is unchanged; `known=` already carries up to 50 SHAs.

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @vault-companion/web e2e` green. Mutation-check each new guard
**in the foreground, one at a time** — memory is tight, so no background shells and no parallel test processes. Commit on
`agent/queue-gate3`.

## Report

`docs/briefs/F4-report.md`. Final line: `F4 DONE <commit-sha> — docs/briefs/F4-report.md`.
