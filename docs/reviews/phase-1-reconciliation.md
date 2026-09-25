# Phase 1 gate reconciliation (Lead)

Reports: `phase-1-review-astra.md` (GPT-6 Astra — **BLOCK**, 3 Critical / 4 High / 3 Medium) and
`phase-1-review-opus.md` (Claude Opus 5.5 — PASS WITH FIXES, 2 High / 3 Medium / 9 Low).
Both reviewed Phase 1 at `be1881f`/`e918603` (same code). All findings accepted. Gate status: **FAILED — fixes in
progress**; the gate is rerun (same brief, fresh contexts, both models) after the fixes land.

Owners: **L** = Lead (domain, stores, worker, contracts) · **K2** = kernel fix worker (brief `docs/briefs/K2-kernel-fixes.md`)
· **F2** = queue fix worker (brief `docs/briefs/F2-queue-fixes.md`).

| Finding | Severity (max) | Decision | Owner |
|---|---|---|---|
| A2 blob-CAS ABA ⇒ duplicate Complete after Undo | Critical | **ADR-0011 head-CAS**: commit parented on X, fast-forward-only ref update (probed: ABA rejected with 422). Executor retry budget 5. Regression: Complete/Undo/delayed-Complete interleaving in executor + real-Git tests. | L |
| A1 / R1 exact Undo wrong section | Critical | Exact inverse moves to the domain: when the file at X is byte-identical to the completion commit's blob, Undo writes the **completion commit's parent bytes** (proved original by head-CAS + replay verification). Kernel exact path hardened too (deep-equal effect, unique candidate) for API correctness. Golden: Done above Open. | L + K2 |
| A5 / R2 semantic Undo adopts lines | High | Refuse or fall back when the insertion point's next non-blank line is indented or would split a block; `verifiedUndo` asserts block lengths of all tasks unchanged except the restored one. | K2 |
| A3 / R3 cross-tab queue | Critical | Web Locks (`navigator.locks`) around claim/cancel/settle/discard; re-read IndexedDB inside the lock; receipts/tombstones persisted so absence ≠ never sent. Fallback when Web Locks is missing: single-sender election via lock-less BroadcastChannel is not attempted — the queue refuses local cancellation (always sends a real Undo). | F2 |
| A7 account change mid-claim | High | Re-check session generation after the claim await, immediately before send. **Server-side binding**: POST carries `X-VC-Account: <accountKey>` (outside the hashed body); Worker compares with the JWT-derived key ⇒ 409 `account-mismatch` (not retryable). | F2 + L |
| A4 Inbox case race | High | Closed by ADR-0011 (listing and create at the same X). Listing via `git/trees/<X>:Inbox` with `truncated` ⇒ `dedupe-unknown`-style refusal (R8). | L |
| A6 JWT without `exp` | High | Require `exp` and `iat`; reject lifetime > 24 h + 5 min skew; tests for missing/malformed `exp`, future `nbf`. | L |
| A8 / R5 adapter path defence; linked-note allowlist | Medium | `assertAdapterPath` at every adapter entry (both stores); `parseVaultPath` rejects C0/C1 and U+2028/2029; `canReadLinkedNote` becomes the Projects/Tasks/Inbox allowlist. | L |
| A9 receipts lost on reload | Medium | Persist receipts in IndexedDB atomically with pending removal; keep until a read reports `included`; bounded only after acknowledgement. | F2 |
| A10 / R10 weak log + wiring tests | Medium | Direct `sanitize` test with forbidden keys (kills the recorded mutant); A18 through real `createCommandService` + InMemoryStore for all four commands incl. refusals; production wiring test with a locally signed token and injected JWKS. | L |
| R4 dependent released on non-final attention | Medium | Release dependents only after a receipt or a refusal known not to have applied (`refused:*`, `conflict:*`, `operation-id-reused`, `invalid`, `account-mismatch`); on predecessor Retry, dependents return to pending behind it. | F2 |
| R6 kernel throws on reachable inputs | Low | Return `refused:structure` (Done insertion in unclosed fence; anchors counted only on visible lines). | K2 |
| R7 blank residue in Done after semantic Undo | Low | Effect records `blankInserted`; semantic inverse removes that blank when it is still blank and Done has no other content. vault-contract §4.2 amended. | K2 |
| R8 listing > 1000 | Low | Trees API + `truncated` ⇒ refuse (see A4). | L |
| R9 compare truncation | Low | Page `per_page=250&page=n` until `total_commits` seen (probe: unpaged returns newest 250); cap 20 pages ⇒ `unknown`. | L |
| R11 onError 500 / config gaps | Low | `onError` ⇒ 503; `configProblems` validates `USER_TIME_ZONE` and https `ACCESS_TEAM_DOMAIN`. | L |
| R12 receipt op-ID not checked | Low | Receipt whose `operationId` differs ⇒ `retry` (never settles the item). | F2 |
| R13 NBSP after block ID dropped | Low | Trim only `[ \t]` on both paths. | K2 |
| R14 capture before a paragraph line | Low | Capture `refused:structure` when the first non-blank Open line is not a list item (ADR-0010 amended). | K2 |

## Contract changes made for these fixes

`docs/commands.md` (head-CAS algorithm, paging, account header, receipt persistence, dependent release, cross-tab),
`docs/vault-contract.md` §4.2 and §4.4, `docs/security.md` (JWT claims), ADR-0010 note, ADR-0011.
