gpt-6-astra

# Phase 1 gate run 3 — independent adversarial review

**Verdict: PASS WITH FIXES — 3 findings (0 Critical, 0 High, 3 Medium).**

Reviewed `main`, starting at `2a0c17e38c1b372347c53edd95a798ac22df6e1b`, against the Phase 1 scope since `0cc7286`. At final verification, HEAD was `9d451900b62d1ed4d4ebb52c239f4430c35a2b1b`; the intervening changes affect only `docs/checkpoint.md`, `docs/orchestration.md`, and `docs/plan.md`. `packages/` and `apps/` are unchanged, so the execution evidence applies to both revisions. Date: 2026-09-25.

Followed the brief and both rerun addenda. Read the four permitted earlier reports, reconciliation, required project contracts, ADRs, K/F reports, and recorded GitHub probes. Did not read any existing `phase-1-rereview2-*.md` report, spawn agents, access the reference/live vault, make network writes, or change repository implementation/tests. Only this report was written in the repository. All custom scripts, mutant copies, and disposable Git repositories are under the OS temporary directory; all inputs are synthetic. The two staged documentation files present at the start were left untouched by this reviewer.

The previously demonstrated durable overwrite and duplicate-completion blockers are closed. The remaining failures concern cross-tab read evidence, interrupted dependency updates, and the command/receipt/read schema boundary. None of the new reproductions loses Markdown bytes, duplicates a committed operation, or bypasses authentication.

## Findings

| id | severity Critical/High/Medium/Low | file:line | problem | concrete failing input or interleaving | recommended fix |
|---|---|---|---|---|---|
| G3-1 | Medium | `apps/web/src/queue/queue.ts:242`, `:250`; `apps/web/src/reads.ts:22`; `apps/web/src/ui/App.tsx:65` | **Receipt eviction in one tab permits another tab to render a saved completion as authoritative open.** The new sequencer orders responses within one App instance; it does not implement the revision watermark promised in the reconciliation. Once a receipt is evicted, neither `knownCommits` nor `buildView` can protect its task. This leaves Astra rerun N3 / original A9 partially fixed and violates `commands.md` F10 and acceptance A33. | Executed with two real IndexedDB connections, the real queue, service, and kernel. A begins read R0 before any completion and holds its response. B completes 21 distinct tasks, reads a revision including all 21 receipts, then acknowledges them. Automatic retention evicts the first receipt. A reloads durable queue state through `kick`, then receives R0. A's local `ReadSequencer.accept(R0)` returns true. Actual durable open count is **0**, but `buildView` renders **Synthetic 1 open with `action:null`**, and only 20 Done overlays. No force-push, stale replica, or out-of-order response within B is required. | Persist shared revision/ancestry evidence before evicting receipts, and require every tab's accepted read to include that watermark. Ensure an already-in-flight read which did not request the current watermark cannot become authoritative after eviction. Alternatively retain receipt evidence until a protocol proves all relevant readers safe. Test acknowledgement/eviction in B against a held response in A, plus reload and explicit saved-entry removal. Merely increasing 20 or adding a per-tab request counter does not establish F10. |
| G3-2 | Medium | `apps/web/src/queue/queue.ts:202`, `:207`, `:210`, `:400`; `apps/web/src/queue/db.ts:132` | **Retry's predecessor reset and dependent generation update are separate durable transactions.** The Web Lock prevents simultaneous execution, but does not make the sequence crash-atomic. An interruption after persisting C as pending and before incrementing U's generation reintroduces the original late-refusal race. Astra rerun N2 / original R4 are partially fixed under restart/storage failure. Conflicts remain visible; this is not silent deletion. | Executed the original real-service interleaving: C initially receives a known-not-applied refusal; A sends dependent U, whose missing-target refusal is held. In B's `retry(C)`, allow C's pending reset to commit, then inject a storage exception immediately before the separate U generation transaction. Close B and open a replacement queue. It sends C successfully. Release A's old U refusal. U still has generation **0**, so settlement makes it permanently `attention/conflict:task-changed`; only C has a receipt and the Markdown is `- [x] A #todo ✅ 2026-09-25`. This injected interruption reproduces the durable state of termination between those two transactions; it was not a physical browser-crash experiment. | Add a store operation that atomically persists the predecessor retry and every affected dependent generation/state in one IndexedDB readwrite transaction, under the existing Web Lock. Publish cache updates only after commit. Test aborts at the transaction boundary and restart before the held dependent response is released; final state should follow the queued Undo without requiring another manual retry. |
| G3-3 | Medium | `packages/contracts/src/index.ts:8`, `:27`, `:34`, `:71`; `packages/domain/src/commands.ts:47`, `:126`; `apps/web/src/queue/classify.ts:29`; `apps/web/src/api.ts:33` | **Schema-valid commands can commit results that violate the receipt and task-read schemas.** `singleLine` is capped at 4,000 UTF-16 code units, but capture permits 2,000 text plus 2,000 context before adding formatting, and completion appends a done field to an already-valid locator. The service writes without checking this output boundary. The client rejects the durable receipt, retries forever, and rejects the task response while the oversized line is included. Violates `commands.md` receipt/retry behavior and the product's usable task views. | HTTP-through-real-service reproduction 1: CaptureTask with `text = 'x'.repeat(2000)` and a valid 2,000-character HTTPS context passes `Command`; HTTP 200 commits a **4,026-character** task. `Receipt.safeParse` and `TasksResponse.safeParse` both fail; `classify` returns retry/invalid-response. Retrying gives `already-applied`, still rejected, with exactly one Git effect. Reproduction 2: seed a **3,995-character** open task, whose initial TasksResponse and CompleteTask envelope both validate. Complete produces a **4,008-character** completed line and the same invalid receipt/read outcome. The capture context case is reachable through the supported API (the current capture sheet does not expose context); the completion case is reachable from the current task UI against an otherwise supported desktop-created task. | Make accepted mutation results closed under the public receipt/read contracts. Separate submitted-text limits from persisted task-line limits, or perform a typed pre-write size refusal with sufficient room for generated fields. Ensure existing larger vault lines cannot invalidate the entire task response. Add boundary tests through command validation → mutation → HTTP receipt validation → subsequent TasksResponse validation, including deduped retry. Do not truncate vault text to satisfy the schema. |

## Evidence run

### Baseline and scope

- `git diff 0cc7286..HEAD --stat -- packages apps`, targeted source/test inspection, branch/revision/status checks. No state-changing Git operation against this repository.
- `pnpm test --maxWorkers=1 --no-file-parallelism`: **27 files, 432 tests passed**, 41.74 seconds. This includes the 4,000-document kernel property corpus, original golden reproductions, disposable real-Git contracts, worker auth/wiring tests, and queue gates.
- `pnpm lint`: **passed**.
- Only one test invocation was active at a time; every Vitest invocation explicitly disabled file parallelism and limited workers to one. No background shell jobs or other agents were started. Vitest's summary counts workers created sequentially over the run, not simultaneously running workers.
- Did not run a build, `tsc -b`, browser e2e, or a new remote GitHub probe. Existing recorded remote behavior is historical evidence, distinguished from this run's local tests. In particular, this is not a new live-GitHub stress test or a physical browser crash test.

### Original rerun reproductions, executed again

Inspected the earlier temporary scripts before executing them against the current source:

```powershell
node --experimental-transform-types "$env:TEMP/vc-astra-originals.mts"
node --experimental-transform-types "$env:TEMP/vc-astra-rerun.mts"
node --experimental-transform-types "$env:TEMP/vc-astra-truncated.mts"
```

Results:

- **A4 case race:** the desktop's lowercase `alpha` lands between plan and write; capture returns `Inbox/Alpha - 2026-09-25 (2).md`, preserving the existing note.
- **A8/R5 path corpus:** 36 unsafe-path rejections across read/list/write and both adapters; zero token/network calls; C1 path rejected; Finance linked-note predicate false.
- **A6 missing expiry:** locally signed allowed-identity token with `iat:1` and no `exp` returns `{ok:false}`.
- **Rerun Astra N1 directory collision:** real capture planner + GitHub adapter + synthetic HTTP tree containing `Alpha - 2026-09-25.md` as a directory now write the suffixed `(2).md` path. The emitted tree request does not replace the occupied directory.
- **Rerun Astra N2 normal retry interleaving:** both C and U settle, durable pending list is empty, and the exact original open Markdown is restored. This closes the original uninterrupted reproduction; G3-2 adds an interruption between durable updates.
- **Rerun Astra N3 retained receipt:** acknowledgement followed by a stale response now gives zero open rows and one saved completion overlay. This closes the original retained-receipt reproduction; G3-1 removes the receipt through the production eviction rule.
- **Rerun Astra N5 / Opus N3:** truncated Inbox listing through HTTP yields **422 `refused:too-large`, `retryable:false`, zero writes**.

### New failing inputs and interleavings

Scripts written under `%TEMP%` and executed against the actual repository modules:

```powershell
node --experimental-transform-types "$env:TEMP/vc-astra-rereview2-seams.mts"
node --experimental-transform-types "$env:TEMP/vc-astra-rereview2-interrupted.mts"
```

The first script uses the real Hono app, command schemas, command service, kernel, InMemoryStore, client classifier, two IndexedDB connections, shared locks, `ReadSequencer`, and `buildView`. Selected output:

```text
LONG_CAPTURE_INPUT true 2000
LONG_CAPTURE_RESULT http=200 length=4026 receiptValid=false
  outcome=retry/invalid-response readValid=false commits=1
LONG_CAPTURE_RETRY receiptStatus=already-applied
  outcome=retry/invalid-response commits=1
LONG_COMPLETE beforeValid=true inputValid=true inputLength=3995
  completedLength=4008 http=200 outcome=retry/invalid-response afterValid=false
CROSS_TAB_EVICTION durableOpen=0 retained=20 accepted=true
  renderedOpen=[{description:"Synthetic 1",action:null}] renderedDone=20
```

The second script interrupts Retry before the dependent's database write, then reopens the interrupted tab's queue:

```text
RETRY_INTERRUPTED simulated interruption before second IDB transaction
INTERRUPTED_GENERATION
  text="## Open\n## Done\n\n- [x] A #todo ✅ 2026-09-25\n"
  pending=[{type:"UndoCompleteTask",state:"attention",generation:0,
            error:{code:"conflict:task-changed",message:"that completion is not in the vault"}}]
  receipts=["CompleteTask"]
```

### Verification of every original finding

“Fixed” refers to the reported failure, not certification of all behavior of that subsystem. Partial entries identify the remaining boundary explicitly. IDs are kept separate even where the two original reports overlap.

| Original ID | Status | Current evidence |
|---|---|---|
| A1 | fixed | Domain exact Undo writes the verified completion-parent bytes. Executed five `commands-gate` shapes, including Done above Open, no final newline, CRLF, BOM, and prose; exact original bytes restored. |
| A2 | fixed | Executed delayed-C → identical C → U → delayed-C regression: only one C commit, U stands. Real-Git shared contract rejects the stale base after ABA. GitHub still parents on X and publishes with `force:false`. |
| A3 | fixed | Executed two-connection stale-tab Undo cases after settlement and during an in-flight claim. Locked reload and persistent receipt prevent erroneous local cancellation. |
| A4 | fixed | Independently reran the injected case-variant desktop commit; replan picks `(2)`. The dedicated command gate now guards this exact interleaving. |
| A5 | fixed | Original indented section-context and anchor-gained-child cases return `refused:structure`. Golden/property tests pass; semantic Undo verifies restored and other task block lengths. |
| A6 | fixed | Independently reran missing-exp signed token: rejected. Auth suite covers required expiry/iat, future claims, lifetime, signature, issuer, audience and identity. |
| A7 | fixed | Queue tests cover session switch during claim persistence, sign-out during claim, and switch after lock release. Worker checks `X-VC-Account` against the verified identity before executing. |
| A8 | fixed | Independent 36-call adapter corpus rejects all unsafe paths before I/O. Path policy rejects C1/separators and linked-note scope is Projects/Tasks/Inbox. |
| A9 | partially fixed | Atomic receipt persistence, reload overlay, and retention of unacknowledged receipts pass. Retained acknowledged receipts now overlay stale reads correctly. Cross-tab eviction still loses needed evidence: G3-1. |
| A10 | fixed | Full service sentinel matrix and production verifier wiring pass. Independently removed the logger allowlist and injected service `console.error(payload)` in temp copies: both mutations are killed. |
| R1 | fixed | Original minimal Done-above-Open inputs execute in kernel/domain regressions. Kernel exact inverse checks every effect field and uniqueness; domain restores verified parent bytes. |
| R2 | fixed | Both original no-adoption inputs refuse; safe semantic Undo preserves edited child lines. Whole-suite kernel properties and golden tests pass. |
| R3 | fixed | Same original stale-cache cancellation defect as A3; executed cross-tab claim/settlement/cancellation and expired-claim tests. |
| R4 | partially fixed | Non-final attention keeps dependents waiting, normal predecessor Retry requeues dependents, and the original held-response race is fixed. Crash-atomic dependency generation is absent: G3-2. |
| R5 | fixed | Same adapter defense as A8, independently executed before any token/network calls and covered by real-Git contract tests. |
| R6 | fixed | Original unclosed fence/comment Done cases now return typed refusals; hidden anchors are excluded. Exact reproduction tests and property corpus pass. |
| R7 | partially fixed | Empty-Done inserted blank is removed, including reversed section order. Blank residue with other non-blank Done content remains the explicitly accepted/deferred limitation, covered by a test and the amended §4.2 rule. Not counted again as a new finding. |
| R8 | fixed | Tree listing includes all entry types and truncation refuses. Independently verified terminal HTTP 422 rather than retryable 503; adapter tests cover the truncated flag. |
| R9 | fixed | Explicit immutable-base/head compare paging reaches page 2 after 250 commits; empty/exhausted windows refuse instead of writing. Executed adapter paging and domain/store unknown-window tests; recorded 260-commit remote probe supports API assumptions. |
| R10 | fixed | Real-command sentinel matrix, local signed-token production composition, direct allowlist guard, and console capture are present. Both historical logger mutants are now killed. |
| R11 | fixed | Invalid timezone/HTTP team-domain configuration tests pass. Generic onError returns 503; changing it back to 500 in a temp copy fails the new test. |
| R12 | fixed | Mismatched operation-ID receipt is classified as retry and leaves the pending record intact. Executed queue gate. |
| R13 | fixed | NBSP after block ID is preserved; trailing ASCII tab is trimmed. Executed all three trailing-whitespace regressions. |
| R14 | fixed | Paragraph-first capture refuses; normal list-item-first capture succeeds. Executed direct and semantic-Undo-fallback regressions against the amended rule. |

### Verification of every rerun finding

| Rerun ID | Status | Current evidence |
|---|---|---|
| Astra N1 | fixed | Directory collision reproduction now chooses `(2)`. All three adapters enforce `WriteRequest.expect`; shared real-Git/memory and GitHub tests cover occupied files/directories and missing update targets. Removing each adapter's precondition kills its tests. |
| Astra N2 | partially fixed | Original uninterrupted two-tab reproduction now restores the open task; lease-expiry/reclaim test passes. Generation comparison mutant is killed. Interruption between separately committed retry/generation writes still fails: G3-2. |
| Astra N3 | partially fixed | Original R0→C→R1→late-R0 is rejected by the sequencer; retained acknowledged receipts consult the rendered response's `known`, including reload. Both guards are mutation-tested. No shared durable revision watermark protects evicted receipts: G3-1. |
| Astra N4 | fixed | Rebuilt the original service-console-payload mutant from current source. Sentinel assertion now fails; four other wiring tests pass. This is an assertion failure, not a setup/import failure. |
| Astra N5 | fixed | Same original truncated-tree HTTP reproduction returns terminal 422 with zero writes. |
| Opus N1 | fixed | Wrong empty listing can no longer overwrite an existing note: independent exact-path precondition refuses. GitHub confirms absence from the parent tree; existing-directory 404 fails closed. LocalGit rejects an unknown commit instead of returning an empty list. Executed current shared/store/gate tests and GitHub fail-open mutant. |
| Opus N2 | fixed by documented scope decision | ADR-0011 now explicitly records GitHub's acceptance of fast-forward publication after an out-of-contract rewind, unlike exact local/memory head equality. W1 and planned G2 ruleset are the stated boundary. Not claiming the adapters now behave identically under force-push; no new remote rewind probe was run. |
| Opus N3 | fixed | CaptureNote catches `FileTooLarge` from listDir and returns `refused:too-large`; independently verified through HTTP. |
| Opus N4 | fixed | `wiring.test.ts` exercises a thrown service error and asserts 503/retryable/no detail. Independent 503→500 mutation fails. |
| Opus N5 | fixed | `postCommand` supplies a 30-second abort signal, shorter than the 60-second lease. Executed gate test aborts the stalled real POST wrapper, observes pending/retry with released lease, and sends the next queued item. It verifies signal attachment and timeout classification; it does not wait 30 wall-clock seconds or exercise a suspended mobile browser. |
| Opus N6 | fixed | Undo commits carry `Vault-Companion-Undoes`; the plan searches T..X for an earlier Undo before applying. C1→U1→C2→U(C1) refuses, preserving C2. Disabling the found-Undo guard makes that gate fail. All three adapters honor the supplied trailer key in their search implementation. |
| Opus N7 | fixed | Listings include directories; updates require an existing `100644` blob in production/local Git. GitHub executable/directory precondition tests pass and fail when the guard is disabled. InMemoryStore has no mode representation, so executable-mode verification is adapter evidence, not memory-model evidence. |
| Opus N8 | fixed | A4's injected case-variant between planning and publication is now a dedicated command gate; executed both it and the earlier standalone reproduction. |

### Test-strength checks

**Eleven intentional mutants, all killed by assertion failures**, using current tests copied into `%TEMP%`; production repository files remained unchanged:

| Mutant / production guard | Evidence |
|---|---|
| Remove `ALLOWED.has(k)` from `apps/worker/src/log.ts:26` | Direct allowlist assertion fails as body/path/text survive: 1 failed, 22 skipped. |
| Print submitted payload at the start of `createCommandService.execute` | Real-stack console sentinel assertion fails: 1 failed, 4 passed. |
| Disable GitHub precondition at `contents-store.ts:145` | All five directory/executable/missing/file-create/directory-create assertions fail. |
| Return null for a known-existing directory's failed listing at `contents-store.ts:122` | Fail-closed listing assertion fails. |
| Disable LocalGit precondition at `local-git-store.ts:142` | Real disposable-Git occupied-file create assertion fails. |
| Disable InMemoryStore precondition at `in-memory-store.ts:158` | Shared memory occupied-file create assertion fails. |
| Disable found-Undo refusal at `commands.ts:93` | Stale second Undo is applied; command gate fails. |
| Change `app.ts:130` onError status from 503 to 500 | New unexpected-service-failure assertion fails. |
| Disable dependency-generation comparison at `queue.ts:400` | Held-refusal test observes no second U send and fails. |
| Restore sticky-acknowledged reflection at `view.ts:33` | Reload stale-read test renders an open row and fails. |
| Disable older-ticket rejection at `reads.ts:23` | Sequencer test accepts R0 after R1 and fails. |

Commands/builders used, sequentially:

```powershell
node "$env:TEMP/vc-astra-mutant-builder.mjs"
pnpm exec vitest run --config "$env:TEMP/vc-astra-vitest.config.mjs" --configLoader native --root "$env:TEMP" --maxWorkers=1 --no-file-parallelism
node "$env:TEMP/vc-astra-allowlist-builder.mjs"
pnpm exec vitest run --config "$env:TEMP/vc-astra-allowlist.config.mjs" --configLoader native --root "$env:TEMP" --maxWorkers=1 --no-file-parallelism -t 'runtime log allowlist'
node "$env:TEMP/vc-astra-rereview2-mutant-builder.mjs"
pnpm exec vitest run --config "$env:TEMP/vc-astra-rereview2-mutants/config.mjs" --configLoader native --root "$env:TEMP/vc-astra-rereview2-mutants" --maxWorkers=1 --no-file-parallelism
node "$env:TEMP/vc-astra-rereview2-web-mutant-builder.mjs"
pnpm exec vitest run --config "$env:TEMP/vc-astra-rereview2-web-mutants/config.mjs" --configLoader native --root "$env:TEMP/vc-astra-rereview2-web-mutants" --maxWorkers=1 --no-file-parallelism
```

The six-source store/domain/HTTP mutation run had **10 expected assertion failures, 12 passes, 84 skipped**. The three-source web mutation run had **3 expected assertion failures, 2 passes, 61 skipped**. No startup failures were counted as kills.

The existing tests are effective against those production guards; the new findings are gaps in composed scenarios, not vacuous assertions in those tests. Specifically, the new read tests retain the one receipt throughout; dependency tests finish every Retry database write; command tests do not validate generated boundary-length responses against the actual client schemas.

## What is sound

- **Durable write safety is substantially improved.** Pinned X, dedupe-before-write, parent-on-X commits and non-force publication close the demonstrated ABA. The newly independent create/update precondition closes the Git Data replacement hole. Occupied directory names count in collision selection, and uncertain/truncated listings cannot reach a successful create.
- **Undo's verified exact inverse and one-Undo guard work on the reviewed cases.** Parent bytes are used only after authenticating the target and replaying its completion. The semantic inverse refuses adopting unrelated child lines and validates block preservation. Repeating an already-undone target cannot reopen the later app completion in the reported scenario.
- **Kernel preservation checks remain strong.** Original section-order/BOM/EOL/final-newline, NBSP, child-block, conflict-marker, recurring/on-completion, duplicate-field and ambiguous-locator regressions pass. No new durable corruption was reproduced in this review.
- **Authentication and write request guards remain intact.** Required JWT claims, independent signature/issuer/audience verification, lifetime, identity allowlist, Origin/custom-header checks, account binding and fail-closed configuration are present. No auth bypass found. The former console logging test blind spot is closed with a demonstrated mutant kill.
- **Queue safety is improved on uninterrupted paths.** Locked durable reload prevents stale local cancellation, claim IDs reject older settlements, account generation is rechecked before send, receipts settle atomically, dependency generations repair the original delayed-refusal race, and a command timeout restores progress for a hung POST. G3-1 and G3-2 identify the remaining cross-tab/transaction boundaries.
- **Known limitations remain explicit.** R7's non-empty-Done residue and out-of-contract branch rewinds are accepted restrictions, not newly demonstrated blockers. Workers subrequest sizing and real mobile/background behavior still require the later deployment/device gates. Some older architecture/sync prose still describes blob CAS/three attempts; implementation review used the superseding ADR-0011 and current commands contract, rather than treating that obsolete wording as intended behavior.

## Verdict

**PASS WITH FIXES.** The previous Critical reproductions are fixed, and the new guards are covered by tests that fail when those guards are broken. Three narrower, concrete Medium failures remain. Fix G3-1 and G3-2 before relying on cross-tab/restart completion-and-Undo behavior, and close G3-3 before treating all schema-valid task commands as supported. Re-run these exact seam reproductions after the fixes; 432 passing baseline tests do not establish those missing end-to-end guarantees.
