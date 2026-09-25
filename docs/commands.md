# Commands, receipts and retries

Reconciled with the Phase 0 architecture review (F1, F4, F5, F9, F10, F11, F18, F19, F20).

## Envelope

```ts
type CommandEnvelope<T> = {
  schemaVersion: 1;
  operationId: string;   // UUIDv4 minted when the action/draft is created, persisted before the first send,
                         // reused byte-for-byte on every retry (F19)
  type: 'CompleteTask' | 'UndoCompleteTask' | 'CaptureTask' | 'CaptureNote';
  occurredAt: string;    // ISO-8601 with offset: the user's action instant
  baseRevision: string;  // commit SHA the client last read
  payload: T;
};
```

`payloadHash = sha256(JCS(raw submitted envelope))` — RFC 8785 canonical JSON over the body **as received**,
before any schema defaults are applied (F18). Schema changes bump `schemaVersion`; the server accepts every
version it has shipped.

Payloads:
- `CompleteTask { task: { path, blobSha, lineIndex, lineText, occurrencesAtRead } }`
- `UndoCompleteTask { target: <the original CompleteTask envelope, verbatim> }` — the server authenticates it
  by its payload hash against the target commit's trailer and re-derives the effect itself (F4/F5).
- `CaptureTask { text, priority?, due?, context? }`
- `CaptureNote { text, context? }`

## Receipt

```ts
type Receipt = {
  operationId: string;
  status: 'applied' | 'already-applied';
  path: string;          // affected file (sensitive: never logged in clear, F20)
  commitSha: string;     // resulting durable revision
  blobSha: string;       // resulting blob of `path`
  effect: Effect;        // typed per command, derived server-side (below)
  flags?: ('backdated')[];
};
```

Errors: `{ operationId, code, message, retryable }` — codes in `vault-contract.md` §5 plus
`operation-id-reused` (409), `dedupe-unknown` (409, not retryable: needs attention), `unauthorized` (401),
`forbidden` (403), `invalid` (400), `clock-skew` (400), `upstream-unavailable` (503, retryable).

## Execution algorithm (server)

All reads and the dedupe of one attempt refer to **one immutable commit X** (F1):

```
1. Validate envelope (schema, path policy, occurredAt skew).
2. X := resolve main → commit SHA.
3. DEDUPE: findOperation(baseRevision..X, operationId) → found | not-found | unknown   (F9)
   - found, same payloadHash  → return already-applied receipt with effect derived from that commit.
   - found, other payloadHash → operation-id-reused. No write.
   - unknown (truncated window, base unknown/not an ancestor, 404) → dedupe-unknown. No write.
4. Read file(s) and directory listings at X. Apply the pure mutation → new content, or refusal/conflict (no write).
5. Commit parented on X with trailers; publish by fast-forward-only ref update from X (ADR-0011).
   - success → applied receipt.
   - precondition-failed → refused:structure (not retryable); no write.
   - head-moved (any commit after X, 422 "not a fast forward") → back to 2; max 5 loops → conflict:stale.
   - unknown outcome (timeout, reset, 5xx on the ref update) → back to 2. Never blind-retry.
   - unavailable before the ref update → upstream-unavailable (retryable).
```

Why this is airtight: the ref can only advance from X, so **any** commit after X — our own earlier attempt, a
desktop sync, or an Undo that restored identical bytes (review A2, the ABA case) — makes step 5 fail and step 3
runs again against a newer X that contains it. Blob CAS alone was insufficient (ADR-0011).
Dedupe pages the compare API (`per_page=250&page=n`) until `total_commits` are seen; the unpaged response returns
only the newest 250 (probe 2026-09-25). More than 20 pages ⇒ `unknown`.

Every write carries `expect: 'absent' | 'regular-file'`, checked by the adapter in the pinned tree X:
note creation requires absence (no file or directory); task updates require a regular file (mode `100644`).
See [ADR-0011](decisions/0011-head-cas-writes.md) for head-CAS and the create/update precondition.

`MAX_TASK_LINE` is 16,000 (JavaScript string length): a write whose resulting task line would exceed it
returns `invalid` before writing; longer existing task lines are omitted from reads and counted in
`omittedLongLines`, never truncated.

Account binding: `POST /api/commands` carries `X-VC-Account: <accountKey>` outside the hashed body. The Worker
compares it with the key derived from the verified JWT; mismatch ⇒ 409 `account-mismatch` (not retryable).

### Server-derived effects (F5)

The effect is never taken from the client. For a found or just-created commit C of operation O:
- Re-run the pure mutation of O's envelope on `C^:path` and require the result to equal `C:path`
  byte-for-byte; the mutation's own effect object is then the receipt effect. Mismatch ⇒ `dedupe-unknown`.
- CaptureNote: the created path is taken from C's changed-file list.

`UndoCompleteTask`: find the target's commit T by trailer in `target.baseRevision..X`, check the supplied
target envelope's hash equals T's payload trailer, then search `T..X` for
`Vault-Companion-Undoes: <target operationId>`: found ⇒ `conflict:task-changed`; inconclusive ⇒ `dedupe-unknown`.
A completion can be undone only once; Undo commits carry that trailer. If no prior Undo is found,
re-derive the completion effect from T as above, then:
- **exact inverse** — the file at X is byte-identical to `T:path`: write `T^:path` (the verified original bytes;
  review A1/R1);
- otherwise the semantic inverse (vault-contract §4.2) on the file at X.
Target not found ⇒ `conflict:task-changed` (nothing to undo in Git).

Per effect type:

| Effect | Why no duplicate |
|---|---|
| CaptureTask append | dedupe at X; head-CAS from X |
| CaptureNote create | dedupe at X; case-insensitive collision check on the Inbox tree at X; head-CAS from X |
| CompleteTask | dedupe at X; already-done target ⇒ conflict, never a second `✅` |
| UndoCompleteTask | dedupe at X; Undoes trailer prevents a second Undo of the same completion; inverse requires exact completed text |
| task-ID assignment | not performed in first release |
| recurrence successor | not performed (`refused:recurring`) |

## Reads and stale-state overlay (F10)

`GET /api/tasks?known=<sha,…>` returns tasks parsed at X plus `known: { sha: 'included' | 'not-included' }`
for commit SHAs the client holds receipts for. For a `not-included` receipt the client overlays the receipt's
effect and shows the view as `refreshing` — a saved completion never reappears as authoritative open.

## Client pending queue (PWA)

- IndexedDB store `pending`, key `operationId`: envelope + `accountKey` + `everSent` + attempts + lastError.
- Envelope and op ID are created and persisted **before** the first send; the control is disabled
  synchronously on tap (F19).
- `accountKey` = SHA-256 of the Access identity (`sub`) from `/api/session`. Items are sent only when the
  current session's key matches; mismatch ⇒ attention with *Export* / *Discard*.
- **Dependencies (F4, R4):** Undo of a completion is queued as a dependent of the completion item. A dependent is
  released only after its predecessor has a receipt or a refusal **known not to have applied** (`refused:*`,
  `conflict:*`, `operation-id-reused`, `invalid`, `account-mismatch`). `dedupe-unknown`, unparseable 4xx and other
  non-final states keep dependents waiting; when the user retries a predecessor, its dependents stay behind it.
  `retry` bumps each dependent's `dependencyGeneration` and requeues unleased dependents needing attention;
  an in-flight dependent keeps its claim, but an attention response from the old generation requeues it.
  If the predecessor was provably *never sent by any tab*, Undo removes both locally; otherwise Undo is always a
  real queued command. Items for the same task are sent FIFO.
- **Multiple tabs / installed PWA (A3):** claim, local cancellation, settlement and discard run inside
  `navigator.locks.request('vc-pending', …)` and re-read the IndexedDB record inside the lock; in-memory state is a
  cache, never the basis of a decision. Without Web Locks, local cancellation is disabled (Undo is always sent).
- **Claim lease (F2 decision, accepted by the Lead):** a claim writes `leaseUntil` (60 s) and `claimId` to the record, so
  other tabs neither send, cancel nor discard an item in flight; a crashed tab's lease expires; settlement only writes if
  its `claimId` still owns the record. A request slower than 60 s may be re-sent by another tab — safe by server dedupe.
- **Session changes (A7):** the session/account is re-checked after every awaited step of a claim and immediately
  before the request; the request carries `X-VC-Account`.
- **Receipts (A9, R12):** a receipt is stored in IndexedDB (`receipts`) in the same transaction that removes the
  pending record, and kept until a read reports it `included`; only acknowledged receipts may be evicted. A 200 whose
  `operationId` differs from the sent one is not a receipt (retry).
- Retries: backoff 1 s → 60 s, on `online`, start and focus; the identical stored envelope. No retry limit.
- `postCommand` aborts after 30 s; the queue classifies the abort as `timeout` and retries.
- Session expiry (F11): requests use `redirect: 'manual'`; an opaque redirect, 401, or Access 403 ⇒
  `signed-out` state: queue paused, "Sign in again" performs a top-level navigation, then the queue resumes
  under the accountKey check.
- Retained until a receipt or an explicit user discard. `navigator.storage.persist()` requested; UI says
  "kept on this device while possible".
- Device storage holds only the user's pending commands and recent receipts — never vault file contents.

## UI states (see sync.md)

`pending` (on this device, nothing in flight) · `saving` (request in flight) · `saved` (receipt) ·
`attention` (conflict, refusal, dedupe-unknown, account mismatch) · `signed-out`.
