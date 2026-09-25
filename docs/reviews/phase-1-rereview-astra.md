gpt-6-astra

# Phase 1 rerun — independent adversarial review

**Verdict: BLOCK — 5 findings (1 Critical, 0 High, 3 Medium, 1 Low).**

Reviewed `main` at `0db42048aed05120869adce32ba662f6e49b5a7e`, including the Phase 1 scope relative to `0cc7286`. Date: 2026-09-25. Read the brief and rerun addendum, reconciliation, both permitted original reports, project contracts, ADRs, K/F reports, and recorded GitHub probes. Did not open any rerun report, spawn agents, access the reference/live vault, or make network writes. Synthetic inputs only. This report is the only repository file written; custom scripts, mutants and test configurations are under the OS temporary directory.

The original Critical reproductions are fixed. The gate remains blocked: the replacement Git Data write path has lost the old create-if-absent backstop, while collision checking omits directories. An ordinary capture can consequently replace an existing subtree. Other findings concern queue ordering, stale-read evidence, an incomplete logging regression test, and error classification.

## Findings

| id | severity Critical/High/Medium/Low | file:line | problem | concrete failing input or interleaving | recommended fix |
|---|---|---|---|---|---|
| N1 | Critical | `packages/github/src/contents-store.ts:103`, `:125`; `packages/domain/src/commands.ts:135` | **CaptureNote can replace an existing directory and remove its children from the current tree.** Listing returns only blobs; the planner considers a directory's name available. The Git Data write supplies a `100644` blob at that same path. Head-CAS protects against intervening commits, but does not prove absence in the pinned tree. Violates `vault-contract.md` §1, new files only, and §4.5, any existing name counts as taken. | At X, have `Inbox/Alpha - 2026-09-25.md/keep.md`. Capture `Alpha` on 2026-09-25. Executed the real command service and GitHub adapter against an HTTP fixture containing the occupied name as `{type:'tree',mode:'040000'}`. The adapter drops that name, POSTs a tree entry `{path:'Inbox/Alpha - 2026-09-25.md',mode:'100644',type:'blob',sha:…}`, then publishes and returns `applied`. GitHub documents that supplied entries override base-tree entries at the same path; the subtree therefore disappears from the new tree. A case-variant directory also escapes collision checking. This is a documented API consequence of an executed request trace, **not a destructive live-GitHub experiment**. | Include **all entry types** in collision occupancy, with NFC/casefold rules. Preserve an explicit create-only precondition at the pinned tree; refuse unsupported objects. Test exact-name and case-variant directories with a sentinel child; require suffix `(2)` or refusal, with no descendant removal. |
| N2 | Medium | `apps/web/src/queue/queue.ts:195`, `:202`, `:382` | **Retrying a predecessor can overtake its already-in-flight dependent Undo.** Retry resets only dependents already in attention and not leased. An awaiting dependent still owns its old claim, so its earlier refusal can become final after the completion succeeds. Violates `commands.md` dependencies and acceptance A27. | C gets `refused:structure`; U is released and the real service computes `conflict:task-changed` because C is absent, but hold U's response. Tab B retries C; C commits. Release U's earlier response. Executed with two IndexedDB connections, shared exclusive locks, and the real service/kernel/InMemoryStore for C's retry and U. Final Markdown is `- [x] A #todo ✅ 2026-09-25`; U is permanently attention with “that completion is not in the vault.” No automatic U retry follows. This is visible attention, not silent deletion, hence Medium. | Coordinate predecessor retry with every dependent attempt. Either defer until the dependent settles and then requeue in order, or persist a dependency generation/retry-needed flag so an old refusal cannot become final. Test held responses across two queues and lease expiry/reclaim, keeping envelope bytes unchanged. |
| N3 | Medium | `apps/web/src/view.ts:33`; `apps/web/src/queue/queue.ts:238`; `apps/web/src/ui/App.tsx:63` | **A receipt acknowledged once no longer protects against a later stale read.** `reflected` trusts `acknowledged` even when the current response explicitly says not-included. UI refreshes can overlap and replace state without ordering/ancestry checks. Violates `commands.md` F10 and A33. | Start read R0 before C and hold its response. Complete C. Newer R1 includes C and acknowledges its receipt. R0 then replaces tasks. Executed queue acknowledgement and `buildView` against the original pre-C TasksResponse, explicitly carrying `known[C]='not-included'`: one open row with `state:'saved'`, zero Done rows. The retained receipt's boolean alone suppresses the overlay. Out-of-order HTTP responses suffice; no history rewrite or stale replica is needed. | Prevent read regression with request generations and/or a verified revision watermark. Tie reflection to the currently rendered revision rather than a previous response. Retain enough evidence across reload/eviction to reject older snapshots. Test R0→C→R1→late-R0 and reload variants. |
| N4 | Medium | `apps/worker/src/wiring.test.ts:27`, `:68` | **The real-stack sentinel test still misses direct console leaks from the command service.** It inspects the injected LogSink array, not console output. The command matrix now exists but does not kill the service-layer logging mutation proposed in original R10. Violates `security.md` Logging and `testing.md`/AGENTS test-strength rules. | In a temp copy of `commands.ts`, insert `console.error('LEAK-MUTANT', JSON.stringify(cmd.payload))` at the start of execute. Run unchanged assertions from a temp copy of `wiring.test.ts` against that service. **4/4 pass**, while stderr prints task locators, note title/body, Undo target and `SENTINEL-9c1e` for six command/refusal/outage requests. The original `ALLOWED.has(k)` mutant is now killed separately. This is a test blind spot, **not an observed production leak**. | Capture/assert console log/info/warn/error and applicable sinks during the real-stack sentinel matrix, permitting only expected sanitized structured records. Keep the direct allowlist test. Prove both allowlist removal and service-console-payload mutants fail. |
| N5 | Low | `packages/github/src/contents-store.ts:102`; `packages/domain/src/commands.ts:135`, `:163`; `apps/worker/src/app.ts:130` | **Truncated Inbox listing is not a terminal refusal through HTTP.** The adapter throws FileTooLarge; CaptureNote does not catch it. Generic onError makes it retryable upstream-unavailable. The R8 reconciliation promises refusal, not endless retry of unsupported input. | `{truncated:true,tree:[]}` through the real adapter, service and HTTP app produces **503**, `{"code":"upstream-unavailable","message":"internal error","retryable":true}`. No write occurs. An unchanged directory repeats this forever. | Map the listing exception to a documented non-retryable refusal or safely complete the listing. Add an HTTP-through-real-service test; adapter-only `rejects.toBeInstanceOf(FileTooLarge)` misses the seam. |

For N1, GitHub's [Create a tree documentation](https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28#create-a-tree) specifies that supplied entries override existing base-tree entries at the same path. The executed production trace supplies precisely that replacement, a blob instead of the existing tree. Children remain recoverable in Git history, but disappear from the current branch tree and ordinary checkout. The review's Critical definition includes that reachable durable loss. A Git directory ending in `.md` is valid; unsupported existing structure must not be destroyed. No remote destructive test was performed.

## Verification of every original finding

“Fixed” means the original reported failure is closed with the evidence stated, not certification of the whole subsystem. Original IDs remain separate even where they overlap.

| Original ID | Status | Evidence |
|---|---|---|
| A1 | fixed | `commands.ts:93–99` restores verified parent bytes when current blob equals completion blob. Executed domain Done-before-Open cases with no final newline, LF, CRLF, BOM and prose; kernel regressions and 4,000-document property test also pass. |
| A2 | fixed | Executor supplies pinned X; memory checks head equality; GitHub parents on X and uses force:false; local Git uses update-ref new old. Executed original Complete/Undo/delayed-Complete service regression and disposable-Git ABA contract. One C remains and Undo stands. Read recorded remote ABA rejection. |
| A3 | fixed | Executed two independently opened IndexedDB queue regressions: stale-tab Undo after another tab settles and while its request is in flight. Locked reload plus durable receipt prevents stale everSent cancellation. N2 is a distinct retry/dependency race. |
| A4 | fixed | Independently reran original file-vs-file case race: inject `Inbox/alpha - 2026-09-25.md` between plan and write of Alpha. Head-CAS rejects old plan; replan returns `Inbox/Alpha - 2026-09-25 (2).md`, preserving desktop file. N1 is an omitted existing directory. |
| A5 | fixed | Executed original indented section-context and anchor-gained-child reproductions; both return refused:structure. `mutations.ts:261` blocks adoption; verifiedUndo validates restored and other blocks. |
| A6 | fixed | Independently signed original allowed-identity token with iat:1 and no exp: `{ok:false}`. Full auth suite passes missing exp/iat, future nbf/iat, excessive lifetime, signature/issuer/audience cases. |
| A7 | fixed | Executed session-change-during-persistence, sign-out-during-claim, and after-lock-release cases: no send. Generation rechecked synchronously before send; server checks X-VC-Account against JWT identity. Header tests pass. |
| A8 | fixed | Independent corpus: six unsafe paths × read/list/write × two adapters = **36 guard rejections**, zero token/network calls. C1 domain path is null; Finance linked-note predicate false. Local-Git path tests also pass. |
| A9 | partially fixed | Original save→reload→stale-read and arbitrary 20-item eviction failures are fixed by atomic durable receipts and unacknowledged retention; executed regressions. Acknowledge→later stale read remains wrong (N3), so F10 is not established end to end. |
| A10 | partially fixed | Original removal of ALLOWED.has(k) independently rerun in temp: new direct test fails as required. Real-service matrix and valid production composition now exist and pass. Console leakage still escapes the matrix (N4). |
| R1 | fixed | Minimal Done-above-Open shapes, including no final newline, pass kernel/domain regressions. Kernel compares whole effect and requires unique candidate at `mutations.ts:187–189`; domain uses parent bytes. |
| R2 | fixed | Original anchor gaining `    - child of A` before Undo B and indented-heading-anchor variant refuse. Edited children belonging to B are preserved on safe Undo. Executed kernel regression matrix. |
| R3 | fixed | Same original hole as A3. Shared lock, durable reload and persisted receipt remove stale-cache cancellation. Executed two-tab tests and late-failure-after-settlement/reclaim tests. |
| R4 | partially fixed | Executed dedupe-unknown, non-JSON 4xx and forbidden cases: dependents wait. Retry after U already reaches attention requeues it, as tested. Retry while U's response is in flight remains broken (N2). |
| R5 | fixed | Both adapter entry points reject traversal, absolute, backslash, C1 and separator inputs before I/O; independent 36-call corpus plus shared store tests. |
| R6 | fixed | Executed unclosed fence/%% Done cases: typed refused:structure. Hidden anchor copy no longer counts; visible capture fallback succeeds. cleanAfter and visible-anchor guards present. |
| R7 | partially fixed | Empty-Done blank residue removed; original examples and both section orders pass. Residue with other non-blank Done content remains intentionally tested and deferred by Lead. It complies with amended §4.2's limitation and is not counted again as a new finding. |
| R8 | partially fixed | Trees removes original Contents 1,000-entry cutoff and truncation cannot write. Adapter test passes, but promised refusal becomes retryable 503 through HTTP (N5). Occupancy also omits trees (N1). |
| R9 | fixed | Executed page-2 operation fixture after 250 page-1 commits. Immutable base/X, explicit pages, absence only after total count; cap exhaustion gives unknown. Read recorded 260-commit real API probe; no new remote writes. |
| R10 | partially fixed | Valid signed token reaches session through createProductionApp and wrong audience is rejected. Real-service matrix exists, but original proposed service-payload console mutant still survives (N4, executed with console.error). |
| R11 | fixed | Invalid zone and HTTP team-domain config tests pass; configuration fails closed. Generic onError returns 503. N5 is a distinct missing permanent-error mapping. |
| R12 | fixed | `classify.ts:31` checks receipt operation ID. Executed mismatched receipt test: pending item retained and retried, not settled. |
| R13 | fixed | NBSP-after-ID, NBSP-plus-tab and no-ID tests pass. completedLine trims ASCII space/tab and preserves NBSP in ID suffix. |
| R14 | fixed | Paragraph-first capture returns refused:structure; executed regression. `todo-list.ts:200` and amended ADR-0010/vault contract agree. |

## Evidence run

### Baseline

- Start and pre-report git status empty; branch main; HEAD remained `0db42048aed05120869adce32ba662f6e49b5a7e`.
- Read-only `git diff 0cc7286..HEAD --stat -- packages apps`, revision/status checks, scoped code/test inspection. No state-changing Git command against this repository.
- `pnpm test`: **408 tests / 26 files passed**, 24.56 seconds, including kernel property tests, original regression inputs, real disposable Git, queue gates and auth/log tests. Empty-clone fixture warnings expected.
- `pnpm lint`: passed. `pnpm typecheck`: passed.
- Browser e2e and new remote write probes were not run. Prior recorded browser/integration results are historical evidence only.

### Independent adversarial probes

Scripts are under `%TEMP%`, this run `%USERPROFILE%\AppData\Local\Temp`, importing actual repository modules via absolute paths.

```powershell
node --experimental-transform-types "$env:TEMP\vc-astra-rerun.mts"
node --experimental-transform-types "$env:TEMP\vc-astra-truncated.mts"
node --experimental-transform-types "$env:TEMP\vc-astra-originals.mts"
```

- `vc-astra-rerun.mts`: N1 real capture planner/adapter request trace; N2 two-connection IndexedDB/shared-lock interleaving; N3 production acknowledgement/projection. Outputs:
  - TREE_COLLISION: applied receipt at occupied `Inbox/Alpha - 2026-09-25.md`; tree request supplies replacement blob.
  - RETRY_OVERTAKES_UNDO: `## Open\n## Done\n\n- [x] A #todo ✅ 2026-09-25\n`; C applied receipt, U attention/conflict:task-changed.
  - ACK_THEN_STALE: `{"all":[{"done":false,"state":"saved"}],"done":0}`. Projection isolates the C receipt; no live Undo overlay is included in this check.
- `vc-astra-truncated.mts`: N5 real Hono→service→adapter: HTTP 503 upstream-unavailable/retryable, **zero writes**.
- `vc-astra-originals.mts`: original A4 case race produces suffix (2); A8/R5 gives 36 unsafe-path rejections and zero token/network calls; A6 signed no-exp token rejected.

### Mutation checks

Only temporary source/test copies were mutated; repository production files remained untouched.

```powershell
node "$env:TEMP\vc-astra-mutant-builder.mjs"
pnpm exec vitest run --config "$env:TEMP\vc-astra-vitest.config.mjs" --configLoader native --root "$env:TEMP" --disableConsoleIntercept
node "$env:TEMP\vc-astra-allowlist-builder.mjs"
pnpm exec vitest run --config "$env:TEMP\vc-astra-allowlist.config.mjs" --configLoader native --root "$env:TEMP" -t 'runtime log allowlist'
```

- **Surviving console-payload mutant:** temp commands.ts prints payload immediately inside execute; temp wiring.test.ts changes import locations only, leaving assertions unchanged. **4 tests pass**, while six LEAK-MUTANT records print the sentinel, including note first line/body and Undo target.
- **Killed original allowlist mutant:** remove `ALLOWED.has(k) &&` from temp log.ts; existing direct runtime-allowlist assertion fails because body/path/text survive. **1 failed, 22 skipped**—the intended failure.
- Initial temp Vitest setup attempts ran no tests: default config bundling attempted a disallowed cache directory outside temp; native loading without a temp root found no tests. Native loading with `--root "$env:TEMP"` completed both checks. Startup failures are not counted as mutation kills.

### Test-strength assessment

- Direct logger test now protects `log.ts:26`; the original mutant is killed. Full-stack sentinel assertions must additionally observe console output (N4).
- Undo domain goldens protect parent-byte restoration; kernel regressions check whole-effect and unique-candidate logic, not just guessed inverse bytes.
- Queue predecessor-retry test waits until U is already attention; it misses `queue.ts:202` when U is leased (N2).
- Receipt tests protect atomicity/retention before acknowledgement, but not `view.ts:33` after a newer read acknowledges C and an older response arrives (N3).
- Listing tests explicitly expect directories excluded. Under Git Data replacement semantics that expectation misses the create-only invariant (N1).
- Truncation test stops at adapter exception; it stays green while HTTP misclassifies the permanent condition (N5).

## What is sound

- Original data-integrity blockers: head-based publication closes demonstrated ABA; exact Undo authenticates the target and uses verified parent bytes. No-adoption checks close the original unrelated-child migration cases. BOM/EOL/final-newline and both-section-order tests are green.
- Changed twins remain ambiguous; recurring/on-completion/duplicate fields refuse completion; conflict markers block writes. Paragraph-first capture now refuses in agreement with the contract.
- Each attempt dedupes/reads at immutable X; unknown ref-update outcomes re-enter dedupe. Paged compare avoids the original 250-commit trap and exhausted windows refuse rather than blindly writing. Evidence is current code/local tests plus recorded real API probes, not a new remote stress test.
- Required JWT claims, bounded lifetime, independent signature/issuer/audience verification, exact Origin/custom-header checks and expected-account binding are present and tested. No authentication bypass found.
- Queue locking/durable reload closes original stale-tab cancellation; claim IDs prevent older same-operation failures from overwriting newer claims; session generation is rechecked before sending; receipt settlement is atomic. N2 is an ordering problem between two different operations.
- Production structured logs sanitize keys and hash paths. N4 identifies missing regression coverage, not an observed production disclosure.

## Verdict

**BLOCK.** Fix create-only namespace protection before live-vault use. The original findings are substantially addressed, but R4/A9's end-to-end guarantees and R10's service-log regression protection remain incomplete. Add exact N1–N5 inputs/interleavings at the appropriate seams and rerun the gate; the green 408-test baseline does not cover them.
