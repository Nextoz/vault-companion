# Brief P4-C — Capture draft recovery (Build Contract: minimal local draft recovery)

Type: **implementation**, privacy-relevant. Branch `agent/draft-recovery`. **Claude Code Cloud** (Linux).

## Problem

`apps/web/src/ui/CaptureSheet.tsx` holds text in React state; it is persisted only when Save calls `queue.enqueue`.
Unfinished text is lost on accidental close, reload, reauthentication or interruption.

## Objective

The smallest account-aware draft store, **separate from the pending command queue**:

- One draft per account (`accountKey`): `{ kind, text, updatedAt }` in a new IndexedDB store (bump the DB version with
  a migration that preserves `pending`/`receipts`/`meta`; see `apps/web/src/queue/db.ts`). Saved debounced while
  typing and on `visibilitychange`/`pagehide`.
- Reopening Capture restores the same text and capture type. Discard is deliberate (an explicit button; closing the
  sheet keeps the draft). A successful Save deletes the draft in the same step that enqueues the command, so a draft
  can never also become a second command. Restoring or typing never sends anything.
- Account change: a draft is shown only to the account that wrote it; after sign-in as another account it stays hidden
  (not deleted, not sent). Signed out: draft still restorable locally, Save waits for sign-in as today.
- Storage failure (IndexedDB unavailable, quota, private mode): capture still works; a quiet notice says the draft
  cannot be kept on this device. Never block typing.
- Privacy (`docs/security.md`): drafts are the user's own unsent text, like pending commands — no vault file content,
  never in the service-worker cache, never logged.

## Tests

Unit: debounce/save/restore, kind restored, Save deletes draft atomically with enqueue, account isolation, storage
failure path, migration keeps existing queue data. WebKit e2e: type without saving → reload → reopen → same draft →
save once → exactly one command sent (mock API counts), draft gone. Break each guard once and list the results.

## May change / must not change

May: `apps/web/src/**`, `apps/web/e2e/**` (add specs), `docs/briefs/P4C-report.md`,
`.agent/handoffs/P4C-draft-recovery.md`. Must not: other packages, contracts, queue send semantics.

## Verify and hand off

`pnpm check` + web e2e green. Handoff (`Completed / Important discoveries / Recommend / Verification / Commit`).
**Push early**, then final push. Final line: `P4C DONE <sha>`.
