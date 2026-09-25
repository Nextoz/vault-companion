# Brief F2 — pending-queue fixes from the Phase 1 gate

Type: **implementation**. Branch `agent/queue-fixes`, worktree `C:\Dev\vault-companion-worktrees\queue-fixes`.

## Objective

Fix the queue findings assigned to **F2** in `docs/reviews/phase-1-reconciliation.md`: A3/R3 (multiple tabs),
A7 (session change mid-claim + `X-VC-Account` header), A9 (persisted receipts), R4 (dependent release), R12
(receipt operation-ID check). Normative text: `docs/commands.md` → "Client pending queue (PWA)" (amended 2026-09-25).
Reproductions: `docs/reviews/phase-1-review-astra.md` (A3, A7, A9) and `docs/reviews/phase-1-review-opus.md` (R3, R4,
R12). Write **each as a failing test first**:

- A3: two independently opened queues over one fake-indexeddb database (not two views of one object): (a) tab B sends
  and settles C, then tab A's Undo must send a real Undo (never `cancelled`); (b) a C in flight in B while A undoes.
  Implement with `navigator.locks.request('vc-pending', …)` around claim/cancel/settle/discard and an IndexedDB re-read
  inside the lock. Provide an injectable lock for tests; without Web Locks, local cancellation is disabled.
- A7: session changes during the awaited claim ⇒ the item is not sent (released back to pending/attention). Every POST
  sends `X-VC-Account: <accountKey of the item>`. A 409 `account-mismatch` response ⇒ attention, never retried.
- A9: `receipts` object store written in the same transaction that deletes the pending record; kept until
  `/api/tasks?known=` reports `included`; only acknowledged receipts may be evicted; save → reload → stale read keeps
  the overlay.
- R4: release dependents only on receipt or refusals known not applied (`refused:*`, `conflict:*`,
  `operation-id-reused`, `invalid`, `account-mismatch`); predecessor Retry keeps dependents behind it.
- R12: a 200 whose `operationId` differs from the sent one is treated as `retry`.

Keep the existing Playwright specs green; add an e2e for "Undo in a second tab" if feasible with two pages sharing a
context.

## May change

`apps/web/**`, `docs/briefs/F2-report.md`.

## Must not change

Everything else (the Lead changes the Worker in parallel, including the server-side `X-VC-Account` check).

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @vault-companion/web e2e` green. Mutation-check each new
guard. Commit on `agent/queue-fixes`.

## Report

`docs/briefs/F2-report.md`. Final line: `F2 DONE <commit-sha> — docs/briefs/F2-report.md`.
