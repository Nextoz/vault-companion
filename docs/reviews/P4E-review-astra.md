# PR #14 (P4-E token Undo) — adversarial review, Codex GPT-6 Astra (high), 2026-09-26

**1. High — Undo can reopen the wrong identical task after the intended task is edited.**  
Location: [packages/domain/src/commands.ts:163](packages/domain/src/commands.ts:163), entering [packages/vault-markdown/src/mutations.ts:214](packages/vault-markdown/src/mutations.ts:214).

Concrete reproduction, confirmed through the command service and real Markdown kernel:

1. Open contains task A, `- [ ] A #todo`, with child text `child of target A`.
2. Done already contains unrelated task B, `- [x] A #todo ✅ 2026-09-24`, with child text `child of unrelated B`.
3. Complete A on September 24. There are now two identical completed first lines.
4. Desktop edits A’s first line to `A changed on desktop`, leaving B unchanged.
5. Submit Undo with A’s authentic completion token.

The server returns **`applied` and reopens B, moving B’s child text into Open**. A remains completed with the desktop edit. The semantic inverse only checks uniqueness at X; after the edit, the wrong twin is the unique match.

This is an existing kernel defect retained by the changed Undo path, rather than a newly introduced matching algorithm. It is separate from the explicitly accepted desktop-recompletion residual.

**Fix:** Derive the completed-line occurrence count from the verified replay of C. At minimum, refuse the semantic inverse when that line was ambiguous in C’s result, even if it is unique now. Preserve the exact-byte inverse. Add this regression with distinguishable child blocks.

**2. Medium — A stale envelope cache in another tab strands an Undo whose token is already persisted.**  
Location: [apps/web/src/queue/queue.ts:377](apps/web/src/queue/queue.ts:377), [queue.ts:518](apps/web/src/queue/queue.ts:518), [queue.ts:598](apps/web/src/queue/queue.ts:598).

Confirmed with two `PendingQueue` instances sharing fake IndexedDB and a shared lock:

1. Tab A caches an Undo draft without `targetCommit`.
2. Tab B receives the completion receipt, persists the Undo’s token, and sends it. Its request fails transiently.
3. Tab B acknowledges and clears the completion receipt. This is permitted because the durable Undo now contains its token.
4. Tab A resumes and reloads IndexedDB.

`#reload()` refreshes records but leaves `#envelopes` untouched. Consequently, `#claimNext()` examines A’s cached tokenless draft despite `record.body` containing the token. With the completion receipt gone, it writes **`attention / refused:undo-target-unknown` and sends nothing**.

The persisted command is valid and retryable; the stale cache prevents recovery.

**Fix:** Cache parsed envelopes together with their source `body`, reparsing whenever the body changes, or invalidate them during reload. Add the two-tab sequence above; the existing reload test creates a fresh queue and therefore misses this case.

**3. Medium — Undo dedupe can certify an applied effect without verifying the Undo commit’s bytes.**  
Location: [packages/domain/src/commands.ts:168](packages/domain/src/commands.ts:168).

The new `deriveApplied()` verifies the completion and checks the found Undo’s `Undoes` trailer and affected path. It does **not** verify that the found Undo actually performed the inverse.

Confirmed input:

- Start with a legitimate completion C.
- Create a synthetic commit U after C carrying the requested Undo’s correct operation ID, payload hash and `Undoes` trailer.
- U changes the task list only by appending a blank line; the task stays completed.
- Retry that Undo.

The server returns **`already-applied`, U’s commit SHA, and `effect.kind: reopened`**, although U never reopened anything.

This requires a crafted or incorrectly produced commit already in repository history; a client-supplied SHA alone cannot create it. Nevertheless, it violates the byte-verification rule that the previous default replay path enforced.

**Fix:** Reconstruct the inverse against U’s first-parent task list and compare its output with U’s actual blob before issuing the receipt. Reuse the token and commit information already fetched to preserve the call budget. Add both incorrect-content and deleted-file cases.

**4. Medium — Tests do not protect the GitHub adapter’s new ancestry and short-page guards.**  
Location: [packages/github/src/contents-store.ts:232](packages/github/src/contents-store.ts:232), [packages/github/src/undo-budget.test.ts:48](packages/github/src/undo-budget.test.ts:48).

This is a coverage finding from inspection, not a demonstrated production failure:

- The domain’s non-ancestor regression exercises `InMemoryStore`.
- The new GitHub Undo fixtures only produce `ahead` or `identical`.
- Their commit-array length always equals `total_commits`, including the 251-commit overflow fixture.

Thus those GitHub tests do not detect removal of the new `commitsSince()` status guard or its `commits.length < total_commits` guard. Existing tests of the separate `findOperation()` method do not cover them either.

Concrete missing inputs are `status: 'diverged'` with matching completed bytes at X, and an incomplete response such as `total_commits: 2` with only one returned commit.

**Fix:** Add adapter-level cases for diverged/behind histories, 404/422, a realistic 251-total/250-returned response, and a short response below the limit. Assert typed refusal, one compare request and no writes; mutation-check those exact production guards.

**5. Low — “10 GitHub calls per attempt” excludes installation-token acquisition.**  
Location: [packages/github/src/undo-budget.test.ts:75](packages/github/src/undo-budget.test.ts:75), [packages/github/src/app-token.ts:31](packages/github/src/app-token.ts:31).

The budget test supplies `token: async () => 't'`. Production requests an installation token when its cache is empty or nearing expiry.

A cold successful Undo therefore makes **11 GitHub requests: 10 store requests plus one token request**. Three full attempts with one token acquisition total 31, rather than 30. This does not by itself threaten the stated 50-call target, but the unconditional measured-budget claim is inaccurate.

**Fix:** State the bound as 10 store requests per attempt, plus token/authentication overhead, and include a cold-token case in a composition-level budget test.

**What is sound**

- **Pinned-head validation and publication:** The token comparison uses C and the immutable X resolved for that attempt. File reads and publication use that same X. I reproduced a desktop edit arriving after X was pinned: CAS forced replanning, Undo refused the edited target, and the desktop bytes survived.
- **Concurrent Undo:** Two concurrent submissions of the same Undo produced one durable commit and returned `applied` / `already-applied` with the **same SHA**. Two different Undo IDs targeting the same completion produced one success and one `conflict:task-changed`.
- **Ordinary token checks:** Unknown tokens, wrong operation trailers, altered target-envelope hashes, and completion content inconsistent with replay are refused. Off-branch/fork commits that are not ancestors of X fail the compare check. An ordinary ancestor of C cannot substitute for C without also passing the trailer and replay checks.
- **Merge-token qualification:** The GitHub adapter retains only the first parent. It does not categorically reject merge tokens; a merge with matching trailers and a first-parent change equal to the completion replay can pass. The current check establishes semantic equivalence, not that the token is necessarily the original single-parent app commit.
- **Dedupe-window reasoning:** Under append-only history, an Undo U created after validating C as an ancestor of X necessarily lies in `C..newHead`. If C ceases to be an ancestor, the retry refuses before writing. Narrowing the window therefore does not itself allow a second application.
- **Expiry qualification:** Same-SHA retry recovery is bounded by the page limit. If there are exactly 250 commits after C, Undo can succeed as commit 251; an immediate lost-response retry then returns `refused:undo-expired` before finding its own commit. I reproduced the boundary with the configurable page size. This follows ADR-0013’s current expiry ordering and does not apply twice, but it prevents an unconditional “every retry recovers the same receipt” claim.
- **Later completion qualification:** App Undo followed by re-completion is protected by the `Undoes` trailer. Desktop reopening followed by another completion is not: I reproduced a delayed Undo of C reopening that later completion. `vault-contract.md` explicitly accepts this text-equality residual; token-based Undo does not eliminate it.
- **Client’s normal path:** Token insertion is persisted before sending, subsequent sends use the stored body, and the single-tab reload tests verify identical bytes. Tokenless drafts behind a known-refused completion are dropped; drafts with unknown completion outcomes remain blocked.
- **Bounded work:** The Undo path makes one compare request per attempt, never enters the paged `findOperation()` path, and is limited to three server attempts. The adapter’s existing overflow handling returns `too-many`, rather than treating truncated history as “not found.”

Verification: **308 tests passed across 13 relevant suites**, using native loading and disabled caches to accommodate the read-only environment. Additional inline probes confirmed findings 1–3 and the race/boundary cases above. The initial ordinary `pnpm test` invocation was blocked by Vite’s attempted cache-directory creation; real-Git and browser suites were not run. No files were modified, no dependencies were installed, and the checkout remained clean.

VERDICT: BLOCK
