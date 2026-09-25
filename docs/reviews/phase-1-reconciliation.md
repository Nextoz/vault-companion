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

## Fix results (2026-09-25)

- Lead: `0e6173a`, `1a9a55f` — all L items; regressions mutation-checked.
- K2: `6d01305` (`docs/briefs/K2-report.md`) — 32 tests incl. 4,000-document property test; 13/14 mutants killed,
  1 proven equivalent. **Residual (Low, deferred):** R7 blank residue remains when Done has other non-blank content
  (needs a §4.2 change); recorded in `docs/plan.md`.
- F2: `48e6b49` (`docs/briefs/F2-report.md`) — 20/20 mutants killed; new two-page WebKit e2e for A3. Decision recorded:
  60 s claim lease (`docs/commands.md`).
- Integrated `main`: 408 tests / 26 files green; WebKit e2e 8/8. The property test needed a 60 s timeout under the
  full parallel suite (no assertion changed).
- Next: gate rerun with fresh Opus + Astra (`phase-1-rereview-*.md`).

## Rerun (2026-09-25) — `phase-1-rereview-astra.md` (BLOCK, 1 Critical) and `phase-1-rereview-opus.md` (PASS WITH FIXES)

Original findings: Opus 20 fixed / 4 partial; Astra 17 fixed / 7 partial — every partial maps to a new finding below
or to the R7 deferral. Both reviewers independently found the create-overwrite hole introduced by ADR-0011.
All accepted.

| New finding | Severity (max) | Decision | Owner |
|---|---|---|---|
| Astra N1 / Opus N1 / Opus N7: Git Data write has no create-only guard; listing omits directories and fails open (404 ⇒ empty); mode hard-coded | Critical | `WriteRequest.expect: 'absent' \| 'regular-file'` checked by every adapter against the **pinned tree** before committing (`precondition-failed` ⇒ `refused:structure`, not retried); listing includes all entry types; a missing directory is confirmed from its parent tree, otherwise the listing throws (fail closed); mode must be `100644` for updates. | L |
| Astra N2: predecessor Retry overtakes an in-flight dependent Undo | Medium | Dependency generation: Retry bumps it; a dependent's refusal from an older generation is not final (requeue). | F3 |
| Astra N3: acknowledged receipt vs late stale read | Medium | Read generations (drop out-of-order responses) plus revision watermark; reflection tied to the rendered response's `known`. | F3 |
| Astra N4: sentinel test misses console output | Medium | Real-stack matrix captures `console.*`; service-console mutant must fail. | L |
| Astra N5 / Opus N3: truncated listing ⇒ retryable 503 | Low | Map to non-retryable `refused:too-large` in the plan; HTTP-through-service test. | L |
| Opus N2: GitHub `force:false` accepts any fast-forward (rewind to an ancestor of X) | Low | Out of contract (sync W1); ADR-0011 wording corrected; G2 ruleset blocks force-push. | L |
| Opus N4: `onError` 503 untested | Low | Test. | L |
| Opus N5: `postCommand` without timeout stalls the tab | Low | `AbortSignal.timeout` < lease; abort ⇒ retry. | F3 |
| Opus N6: stale Undo of an already-undone completion reopens a later completion | Low | `Vault-Companion-Undoes: <opId>` trailer; Undo refused if its target already has an applied Undo in `T..X`. | L |
| Opus N8: no A4 regression test | Low | Gate test. | L |
| Opus note: Workers free-plan 50-subrequest cap vs paged dedupe | risk | Record for Phase 3 deploy sizing. | L |

## Gate run 3 (2026-09-25) — `phase-1-rereview2-astra.md` and `phase-1-rereview2-opus.md`: both **PASS WITH FIXES**

No Critical/High. Opus: all 13 rerun findings fixed. Astra: all fixed except G3-1/G3-2 refinements of N3/N2.
**Lead decision: Phase 1 gate PASSED WITH FIXES.** No live write occurs before Phase 3; the items below are fixed with
mutation-checked tests now or tracked to their phase, and are re-verified by the mandatory Phase 2 whole-system review.

| Finding | Sev | Decision | Owner / when |
|---|---|---|---|
| G3-1 cross-tab eviction lets a stale read in another tab render a saved completion open | Medium | Shared durable watermark: before evicting a receipt, persist the acknowledged revision; every tab only accepts reads whose `known` includes the watermark (or that were requested after it) | F4 worker, now |
| G3-2 Retry's predecessor reset and dependent generation bump are two transactions | Medium | One IndexedDB readwrite transaction for the predecessor and all affected dependents | F4 worker, now |
| F3 `App.tsx` read-ordering wiring untested | Low | Extract into a testable function/hook; test held R0 → R1 → late R0 | F4 worker, now |
| G3-3 schema-valid commands can produce > 4,000-char lines the receipt/read schemas reject | Medium | Typed pre-write refusal when the resulting line exceeds the persisted-line limit; read path tolerates long existing lines (read-only reason) instead of failing the whole response | Lead, now |
| F1 keyed `findOperation` untested on real adapters (N6 guard could silently go inert) | Low | Store-contract case with a non-default key; N6 gate through LocalGitStore | Lead, now |
| F2 surviving mutants: root 404 as absent, LocalGit mode, LocalGit ls-tree failure, `unknown` Undoes search | Low | Tests for each | Lead, now |
| F6 spec drift (Undoes, timeout, dependency generation) | Low | Amend commands.md, vault-contract §4.2, sync.md, ADR-0005 | Lead, now |
| F4 no server deadline < 30 s client timeout; Undo = 3 paged searches | Low | Worker deadline (≈20 s ⇒ retryable 503); measure compare latency on sandbox | Phase 3 sizing |
| F5 `known=` checks up to 20+ receipts serially | Low | Bounded concurrency; acknowledged receipts rechecked only when ancestry breaks | Phase 3 sizing |
| Residual: delayed app Undo vs desktop uncheck + re-complete with identical text | accepted | Documented as §4.2 text-equality semantics | Lead (docs) |
