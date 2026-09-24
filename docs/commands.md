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
4. Read file(s) at ref X (blob S). Apply the pure mutation → new content, or refusal/conflict (no write).
5. PUT with sha=S (create: no sha) + trailers.
   - success → applied receipt.
   - cas-mismatch / exists → back to 2 (the winner may be our own earlier attempt); max 3 loops → conflict:stale.
   - unknown outcome (timeout, reset, 5xx after send) → back to 2. Never blind-retry the PUT.
   - unavailable before send → upstream-unavailable (retryable).
```

Why this is airtight: any commit that lands after X and touches the file — including our own earlier
attempt — changes the blob, so the CAS in step 5 fails and step 3 runs again against a newer X that
contains it. A test must commit the earlier attempt *between* dedupe and read and prove one effect.

### Server-derived effects (F5)

The effect is never taken from the client. For a found or just-created commit C of operation O:
- Re-run the pure mutation of O's envelope on `C^:path` and require the result to equal `C:path`
  byte-for-byte; the mutation's own effect object is then the receipt effect. Mismatch ⇒ `dedupe-unknown`.
- CaptureNote: the created path is taken from C's changed-file list.

`UndoCompleteTask`: find the target's commit T by trailer in `target.baseRevision..X`, check the supplied
target envelope's hash equals T's payload trailer, re-derive the completion effect from T as above, then
apply the inverse (vault-contract §4.2) to the file at X. Target not found ⇒ `conflict:task-changed`
(nothing to undo in Git).

Per effect type:

| Effect | Why no duplicate |
|---|---|
| CaptureTask append | dedupe at X; CAS on blob |
| CaptureNote create | dedupe at X; create-without-sha; case-insensitive collision check (vault-contract §4.5) |
| CompleteTask | dedupe at X; already-done target ⇒ conflict, never a second `✅` |
| UndoCompleteTask | dedupe at X; inverse only applies to the exact completed line |
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
- **Dependencies (F4):** Undo of a completion is queued as a dependent of the completion item. A dependent
  is sent only after its predecessor has a receipt or a terminal refusal. If the predecessor was *never sent*,
  Undo removes both locally. If it was ever sent (outcome possibly applied), Undo is always a real queued
  command. Items for the same task are sent FIFO.
- Retries: backoff 1 s → 60 s, on `online`, start and focus; the identical stored envelope. No retry limit.
- Session expiry (F11): requests use `redirect: 'manual'`; an opaque redirect, 401, or Access 403 ⇒
  `signed-out` state: queue paused, "Sign in again" performs a top-level navigation, then the queue resumes
  under the accountKey check.
- Retained until a receipt or an explicit user discard. `navigator.storage.persist()` requested; UI says
  "kept on this device while possible".
- Device storage holds only the user's pending commands and recent receipts — never vault file contents.

## UI states (see sync.md)

`pending` (on this device, nothing in flight) · `saving` (request in flight) · `saved` (receipt) ·
`attention` (conflict, refusal, dedupe-unknown, account mismatch) · `signed-out`.
