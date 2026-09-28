# ADR-0028 — Reclaim a dead tab's send lease at once (Web Locks liveness)

**Status:** accepted (2026-09-28, Lead; known follow-up "lease reclaim after reload", which also caused a flaky e2e).

## Context

A queued command is claimed before its request leaves (`leaseUntil = now + LEASE_MS` = 60 s, a fresh `claimId`), so no
other tab sends, retries or discards it while the outcome is unknown (A3). If the page reloads or closes mid-request,
the lease lives on in IndexedDB and the item shows "Saving…" and is skipped by every flush until the 60 s expire — on a
phone that is a stuck action after any reload during a save.

## Decision

1. **Liveness lock.** While a tab has a claimed request in flight it holds an exclusive Web Lock named
   `vc-claim:<claimId>`, acquired before the claim is persisted and released only after the attempt's outcome is
   persisted (so no other tab can reclaim it in between). The browser releases a lock when its page dies, so a held
   lock ⇔ a live request.
2. **Reclaim.** When the queue opens, and before each claim, it asks `locks.query()` which
   `vc-claim:*` locks are held. A record whose lease is still unexpired but whose `claimId` lock is **not** held is
   treated as unleased (same as today's expiry: `leaseUntil: 0, claimId: null`, persisted), so it is sent again
   (with the same bytes; `everSent` stays true) or can be retried/discarded.
3. **Fallback.** Without `locks.query` (or with `locks: null`), behaviour is unchanged: the lease expires after 60 s.
4. **Safety.** Reclaiming a lease can at worst resend bytes whose first attempt did land: the server's dedupe by
   operation ID (ADR-0005) answers `already-applied`, so exactly-once holds. A lease held by a *live* other tab is never
   reclaimed (its lock is held).

## Consequences

A reload mid-save resumes within one flush instead of 60 s. `LockManagerLike` gains an optional `query()`; tests
inject a fake lock manager that can simulate a dead page (lock released without the attempt settling).
