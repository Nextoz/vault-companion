# Whole-system review (milestone 1) — Codex GPT-6 Astra (high), 2026-09-26

| id | severity | file:line | problem | concrete failing input or interleaving | recommended fix |
|---|---|---|---|---|---|
| P2-A1 | **High** | `packages/domain/src/execute.ts:70`; `packages/github/src/contents-store.ts:193`; `docs/deploy.md:16` | **Token Undo fixes only Undo’s request budget. The other three write commands can exceed Workers Free’s 50 external subrequests per invocation.** The deployment guidance’s statement that Free suffices after ADR-0013 is not supported by the combined build. | A delayed CompleteTask, CaptureTask or CaptureNote has a two-page dedupe window. Four ref races followed by success require **51 GitHub calls with a cold installation token**, before Access JWKS acquisition. At 20 pages, the same sequence requires **141**. CaptureNote with an absent Inbox requires **56 even with one-page dedupe** across five attempts. Reproduced against the real service, adapter and token source with synthetic HTTP responses. | Add an invocation-wide request budget covering authentication, dedupe, planning, publication and retries. Stop safely before exhausting it; preserve the original command for subsequent recovery. Alternatively, make an explicit deployment-plan decision that accommodates the measured bounds. Update the runbook and add budget regressions for **all four commands**, including absent Inbox, old bases, races and lost responses. |
| P2-A2 | **High** | `apps/web/src/reads.ts:16`; `apps/web/src/reads.ts:95`; `packages/domain/src/commands.ts:327`; `apps/web/src/queue/queue.ts:291` | **Receipt reconciliation can permanently prevent task reads on Free.** The client and endpoint accept 50 `known` SHAs, but the server spends one GitHub request per SHA in addition to resolving HEAD and reading the file. Receipt retention then depends on a read that cannot finish. | Let 49 commands receive receipts while task reads fail or remain unavailable. On recovery, the client asks about all 49. With warm authentication, HEAD + file + 49 ancestry comparisons requires **51 calls**. The request fails, receipts cannot be acknowledged or evicted, and the next refresh repeats the same oversized request. A watermark can occupy another slot. Reproduced: 48 SHAs succeeded at 50 calls; 49 failed on attempted call 51. | Bound reconciliation below the complete invocation budget, reserving authentication overhead and the watermark. Process receipt batches with guaranteed progress, retaining unanswered receipts. Add a regression starting with more than 50 unacknowledged receipts and proving that successive budget-limited reads render tasks and eventually acknowledge every receipt. |
| P2-A3 | **Medium** | `packages/e2e/src/desktop.ts:104`; `packages/e2e/src/desktop.ts:111`; `packages/e2e/src/server.ts:54`; `packages/e2e/src/phone.ts:13` | **The disposable evidence does not establish the production-equivalent combined loop.** Its desktop publishes conflicted files with markers; the verified real worker preserves both commits and blocks without publishing markers. Its “phone” also bypasses the browser queue, drafts and service worker, and its server omits linked-note and Active Work services. | Desktop edits a task while the app completes it. The harness publishes a merge containing markers and proves that the app subsequently freezes writes. The real worker instead blocks: GitHub still contains the app’s clean version, so the app has no marker-based conflict signal and may continue writing. No scenario follows this blocked state through owner resolution, subsequent synchronization and receipt/watermark reconciliation. Browser tests separately use MockApi, so they do not close that gap. | Add a desktop mode matching the supplied worker facts: commit local edits, attempt integration, preserve both commits, publish no conflicted merge, report blocked. Test continued app writes while blocked, explicit synthetic owner resolution, eventual convergence and `known=` after the resulting merge. Add at least one browser-queue → real HTTP service → disposable Git acceptance scenario, with the complete production service composition. Keep marker tests as defensive coverage, accurately labelled. |
| P2-A4 | **Medium** | `apps/web/src/view.ts:140`; `apps/web/src/view.ts:174` | **Delayed completions are placed in “Done today” without checking their action date.** Server dates are correct, but the optimistic overlay contradicts them across midnight. | Queue a completion at `2026-09-25T23:59:00+02:00`; render a task response whose Copenhagen `today` is `2026-09-26` while the command is still pending or its receipt is not reflected. `buildView()` places it in Done today. Once GitHub reflects it, the server correctly excludes it because its durable done date is September 25. Reproduced directly through `buildView()`. | Filter completion overlays by the action’s Copenhagen date, consistently with the server. Preserve visibility of older pending actions in Actions. Add midnight/DST cases for pending, saved-but-unreflected and reflected completions; also refresh the displayed day when an app remains open across midnight. |

**Evidence run**

Reviewed checkout: **`de191cad0685d67df93373beac9b9bfbefd7b1b9`**. The working tree was clean after verification. No repository files were written, no dependencies were installed, no agents were spawned, no network writes were made, and no Obsidian vault was opened.

Read the review brief, repository instructions, normative contracts, ADRs, prior Astra reports and Phase 1 reconciliation. Used the supplied September 26 desktop-worker facts as authoritative for this review.

The first test invocation, `pnpm test --configLoader native --no-cache`, failed before executing tests because Vitest attempted to create its temporary SSR cache and the filesystem sandbox denied it. Switching to the threaded pool allowed the suites that did not require filesystem artifacts to run:

```text
pnpm test --configLoader native --no-cache --pool threads --maxWorkers 4 \
  --exclude packages/e2e/** \
  --exclude packages/github/src/store-contract.test.ts \
  --exclude packages/github/src/git-fixture.test.ts \
  --exclude packages/test-vault/src/fixtures.test.ts \
  --exclude apps/web/test/dist.test.ts

42 test files passed
690 tests passed
```

These results include domain, Markdown, GitHub HTTP-adapter, Undo-budget, queue, draft, read-ordering, renderer and Worker tests. **Real-Git suites, browser suites and build-artifact checks were not rerun.** Typecheck was not run because the configured `tsc -b` writes build artifacts. Prior reports’ real-Git and browser results remain historical evidence, not fresh execution evidence.

Additional inline probes ran from the OS temporary directory, without creating files. They imported the production service and adapter, used synthetic content, generated an ephemeral signing key in memory, and supplied synthetic GitHub responses. They demonstrated the request counts, the 50-call failure path, and the midnight overlay failure. They do **not** establish real GitHub latency or actual Cloudflare runtime behavior.

The complete write budget is as follows. Let **P** be the number of compare pages needed to establish that a non-Undo operation is absent, with `1 ≤ P ≤ 20`. Counts assume a valid installation token lasts through the invocation and no transport redirects.

| Command/path | Store calls per full write attempt | One attempt, cold token, P = 1 | Maximum server attempts | Shallow total, cold token | Maximum paged total, cold token |
|---|---:|---:|---:|---:|---:|
| CompleteTask | `P + 8` | **10** | 5 | **46** | **141** |
| CaptureTask | `P + 8` | **10** | 5 | **46** | **141** |
| CaptureNote, Inbox exists | `P + 8` | **10** | 5 | **46** | **141** |
| CaptureNote, Inbox absent throughout losing attempts | `P + 10` | **12** | 5 | **56** | **151** |
| UndoCompleteTask | **10**, one bounded compare | **11** | 3 | **31** | **31**, no paging |

For CompleteTask and CaptureTask, each full attempt consists of:

- HEAD: 1.
- Dedupe: P.
- Task-file read: 1.
- Pinned-tree precondition: 1.
- Base-tree lookup: 1.
- Blob, tree, commit and ref publication: 4.

CaptureNote substitutes an Inbox listing for the task-file read. When Inbox is absent, both the planning listing and the write-precondition listing perform an additional parent-tree lookup. The paged non-Undo dedupe does not populate the base-tree cache used by Undo.

The synthetic probes directly measured **10, 46, 51 and 141** calls for each non-Undo command, and **56** for shallow CaptureNote retries with no Inbox. The **151** figure follows from the same absent-directory path at 20 pages. Undo’s cold-token cases are covered by the passing budget suite.

A cold Access JWKS lookup adds **one further external subrequest**, although it is not a GitHub request. Thus the relevant fully cold totals include **47**, **142**, **57**, **152**, and **32**. Workers Free’s limit is 50 external subrequests per invocation. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Already-applied recovery is cheaper than another full write:

| Recovery path | Store calls in the dedupe-hit attempt |
|---|---:|
| CompleteTask / CaptureTask, found on page P | `P + 6` |
| CaptureNote, found on page P | `P + 4` |
| UndoCompleteTask, found within its allowed page | **7** |

Those calls still share the invocation budget with preceding attempts. Add token acquisition if cold, and JWKS acquisition separately.

The installation normally has a minimum **5,000 authenticated REST requests/hour**. A maximum paged non-Undo invocation consumes approximately **140 repository API requests**, before token issuance: about 35 such invocations exhaust that hourly allowance, without reads. Token issuance is an additional GitHub HTTP call; it should not simply be assumed to debit the same installation-token bucket. [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

Client retries have no finite lifetime count. The queue backs off to one minute and retries indefinitely. Consequently, the per-invocation bounds do not establish an hourly usage bound. Workers Free interrupts oversized invocations earlier, but repeated failed work still consumes GitHub requests. The existing absence of a server deadline also remains a Phase 3 sizing concern: request counts alone do not guarantee completion before the client’s 30-second timeout.

Delayed-command behavior was traced separately from the budget issue:

- CompleteTask and CaptureTask retain the action’s Copenhagen date. The probes submitted September 24 actions on September 26 and produced September 24 `✅`/`➕` fields. CaptureNote likewise retained September 24 in its filename.
- A stale locator resolves only under the documented exact-content rules. CaptureTask chooses its insertion point in the current pinned document; it does not reuse a stale line offset.
- More than 5,000 commits beyond a non-Undo base can produce `dedupe-unknown`. This is a deliberate fail-closed boundary, not evidence that nothing was saved.
- At the boundary, a command can apply as commit 5,001 and then become unrecoverable by the bounded search after a lost response. Undo has the corresponding previously documented 250/251 boundary. Neither path blindly applies again.
- Refreshing tasks does not rewrite an already-queued envelope’s `baseRevision`. Retry therefore does not repair an expired search window. Recovery guidance must preserve the distinction between “not saved” and “cannot establish whether saved”; minting a replacement command automatically would be unsafe.
- Draft Save atomically transfers the claimed draft version into the pending queue. A recovered unsent draft becomes a command when Save is pressed; an already-queued command keeps its original timestamp and body.

The e2e tests are not generally vacuous. The earlier P2A findings have concrete source fixes. The remaining problem is the scope of their claims.

| Existing scenario group | Guard or behavior the assertions protect | Remaining qualification |
|---|---|---|
| LF/CRLF completion; task/note capture | Markdown span changes, capture insertion at `mutations.ts:317`, complete desktop-file equality | Real-Git execution not repeated here. |
| Lost response | Found-operation branch at `execute.ts:79`; response dropped only after the HTTP app finishes | Exercises the synthetic Phone, not persistent browser recovery. |
| Duplicate submission and deterministic collision | Expected-old-head argument at `local-git-store.ts:182` | The ref gate now requires matching parents and an observed losing update. The prior scheduling gap is addressed. |
| Dirty desktop, compatible divergence and push race | Commit-before-integration, merge parents, ordinary push and retry | Supports compatible synchronization; does not establish blocked-conflict recovery. |
| Same-task and same-anchor marker conflicts | Exact two-sided marker bytes; `todo-list.ts:89` write block | Valid defensive tests for committed markers, not the verified real worker’s representation. |
| Stale task and `known=` | Locator rules and ancestry of the returned receipt | Does not exercise the many-receipt budget failure or watermark reconciliation through owner conflict resolution. |
| Token Undo after desktop edits; bad token | Token verification, inverse, dedupe and Undoes checks in `commands.ts` | Useful service/Git coverage; browser token handoff remains separately tested. |
| Setup failure | Early cleanup registration and cleanup execution | The prior resource-ownership issue is addressed. |

Phase 1’s delayed Complete→Undo ABA case, create-only protection and case-collision guard remain covered by passing domain/adapter tests. The e2e file does not independently reproduce every one of those interleavings. That distinction matters when calling this a whole-system gate.

**Phase 3 blockers**

1. **Resolve P2-A1 and P2-A2 before G3.** The present Free-plan claim is insufficient for both writes and their read-after-save reconciliation. Require an explicit, measured deployment budget and tests that enforce it. Paying for a larger limit would remove the immediate 50-call failure, but would not remove GitHub usage or latency concerns.

2. **Establish the real blocked-conflict round trip.** The supplied worker behavior is compatible with preserving both versions; the app should not pretend it receives a conflict signal that does not exist. The existing decision that desktop conflicts surface through the worker’s log/status can remain. Before accepting the proof, test both commits surviving the blocked interval, owner resolution, subsequent app commits and eventual convergence.

3. **Run the missing combined acceptance scenario in a writable disposable environment.** Use the actual browser queue, complete HTTP service composition, real disposable Git and worker-equivalent integration. Include a lost response, reload, delayed upload, desktop merge and receipt reconciliation. Existing separate browser and Git suites provide substantial evidence, but they are not that single loop.

4. **Complete the specified G2 deployment checks before authorizing a live write.** These include whole-host Access protection, the required identity-provider MFA/session policy, single-repository GitHub App permissions, disabled alternate hostnames, delivered security headers, and the `main` ruleset blocking force-push/deletion. This review did not inspect external configuration.

5. **Prepare the concrete G3 evidence package and installed-iPhone checks.** Record the approved target and expected diff, pre-canary revisions, backup timestamp, owner-run revert procedure, GitHub receipt/trailers, desktop bytes after the real worker, and Obsidian rendering evidence. Real Access login, iOS storage/update behavior, keyboard interaction and latency remain untested here.

P2-A4 should be corrected before claiming the phone’s Today/Done behavior is complete. It does not corrupt durable dates.

**What is sound**

The five prior P4E Astra findings are addressed in source, with their relevant suites passing in this run: ambiguity is checked in the verified completion result before semantic Undo; cached envelopes are keyed by their actual stored body; deduped Undo verifies inverse bytes; adapter ancestry/short-page refusal cases exist; and cold installation-token acquisition is counted.

The earlier P2A review findings are also addressed in source: deterministic CAS coordination, the empty-Open same-anchor case, an injected desktop push race, and early cleanup registration are present. Their real-Git execution results were not refreshed in this sandbox.

The write path retains its essential safeguards: immutable revision pinning, dedupe before mutation, exact-content resolution, pinned-tree create/update preconditions, fast-forward publication, payload verification and fail-closed handling of uncertain history. I found **no new demonstrated Critical durable-loss, duplication, wrong-task-write or authentication-bypass defect** in the paths reviewed.

The queue and draft implementations share one additive IndexedDB v4 schema. Draft Save checks the draft identity/version and enqueues/deletes atomically. Undo tokens are persisted before sending. Receipt eviction remains coupled to a durable watermark, and dependent retry resets are transactional. P2-A2 concerns the ability to obtain the necessary evidence within the platform budget, not removal of those safeguards.

The caching and rendering composition is coherent on inspection and in the passing unit tests: `/api/*` bypasses service-worker caching; linked-note and Active Work responses are not persisted as vault content; renderer code is a static asset; raw HTML is disabled; sanitization restricts tags, attributes and links. The renderer does not require relaxing the static CSP. Actual deployed header delivery and the installed-iPhone experience still require their deployment checks.

Marker-containing task lists block CompleteTask, UndoCompleteTask and CaptureTask. CaptureNote intentionally remains available because it creates an independent Inbox file. Top-of-Open phone capture also remains compatible with bottom-of-Open QuickAdd in the separated-anchor case; empty Open remains an acknowledged conflict case.

**Four findings: two High, two Medium. The demonstrated Free-plan write and reconciliation failures block approval of the combined build for G3.**

VERDICT: BLOCK
