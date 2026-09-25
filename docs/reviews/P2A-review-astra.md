# PR #4 (P2-A harness) — adversarial review, Codex GPT-6 Astra (medium), 2026-09-25

**The harness provides substantial real integration evidence, but it does not fully establish the Phase 2 gate.** It uses real Git repositories, the real command service and HTTP app, and the real JWT verifier. I found no authentication bypass, production-source changes, or private vault text in the added fixtures. The remaining findings concern gaps in what the tests prove.

1. **Medium — Concurrent HTTP requests do not guarantee that the head-CAS guard is exercised.**  
   **Location:** [packages/e2e/src/e2e.test.ts:183](packages/e2e/src/e2e.test.ts:183), [packages/e2e/src/e2e.test.ts:294](packages/e2e/src/e2e.test.ts:294)

   Both concurrency scenarios use `Promise.all`, but neither establishes that two executions read the same head before either publishes. A valid scheduling outcome is that one command finishes its Git operations before the next resolves its head. With that ordering, removing the expected-old-value argument from `LocalGitStore`’s `update-ref` still produces the expected results: the duplicate request encounters a dedupe hit, and distinct commands form a linear history.

   The report’s recorded mutation failures are useful evidence that overlap occurred in those runs. They do not make these tests reliable detectors of a broken CAS guard on subsequent runs.

   **Fix:** Add deterministic coordination around the real Git execution boundary: hold two real ref updates until both have prepared against the same parent, then release them. Preserve the actual `git update-ref` calls and assert that one loses the CAS and replans. A harness-only Git-process wrapper can provide coordination without mocking Git results or changing production code. Record the observed collision as part of the test evidence.

2. **Medium — The required same-anchor append conflict is missing.**  
   **Location:** [packages/e2e/src/e2e.test.ts:225](packages/e2e/src/e2e.test.ts:225)

   The QuickAdd scenario uses six existing Open tasks, deliberately separating the desktop’s bottom insertion from the app’s top insertion. It correctly proves the common clean-merge case introduced by ADR-0010, but it does not cover the same-anchor conflict explicitly required by `docs/testing.md`.

   A concrete remaining case is an empty `## Open`: top and bottom insertion coincide. Concurrent desktop and app captures can then conflict with **nonempty content on both sides**. The existing same-task conflict test does not cover that shape: its remote side inside the Open conflict block is empty, and the completed task appears separately in Done. A defect that loses the remote text inside a two-sided insertion conflict could therefore escape the current assertions.

   **Fix:** Add an empty-Open fixture, make independent desktop and app captures before synchronization, and assert the exact merged Markdown, including both captures inside the conflict markers. Verify that both parent commits remain reachable, the conflict is reported, and subsequent app writes are refused without advancing the remote head. Keep the existing clean-merge scenario.

3. **Medium — The desktop push-race retry path is never exercised.**  
   **Location:** [packages/e2e/src/desktop.ts:85](packages/e2e/src/desktop.ts:85), [packages/e2e/src/desktop.ts:107](packages/e2e/src/desktop.ts:107)

   The report describes desktop synchronization as retrying a push race, but the scenario named “remote race” races app commands against each other and only calls desktop synchronization after they settle. The other scenarios also finish their app writes before calling `sync()`.

   Consequently, replacing the desktop retry loop with a single attempt would leave the existing suite passing. In the real failure scenario, an app commit lands after desktop fetch/merge but before desktop push; the first plain push is rejected, and correctness depends on fetching and integrating that new commit before retrying.

   **Fix:** Arrange a real second writer to advance the bare repository immediately before the desktop’s first push. Assert that the first push is rejected, synchronization subsequently succeeds, both histories remain reachable, and the final file contains both changes exactly. Because `sync()` uses synchronous child processes and blocks the Node-hosted app’s event loop, use a separate process or harness-only Git coordination for the competing write.

4. **Low — Failure during setup can leak the server and temporary repositories.**  
   **Location:** [packages/e2e/src/e2e.test.ts:48](packages/e2e/src/e2e.test.ts:48), [packages/e2e/src/e2e.test.ts:64](packages/e2e/src/e2e.test.ts:64)

   Cleanup ownership is assigned to `current` only after server startup, sign-in, and desktop cloning all succeed. If sign-in or cloning fails, `afterEach` sees `current === null` and skips cleanup, potentially leaving a listening server and temporary Git repositories. Separately, a failed log assertion prevents the final `rmSync` from running. These are particularly unhelpful failure modes in an adversarial suite, where authentication or logging regressions should fail cleanly rather than leave resources behind.

   **Fix:** Register resources for cleanup as soon as they are created. Use `try/finally` so repository cleanup still runs when server shutdown or a log assertion fails, and close/remove partially initialized resources when setup throws.

The other requested checks look sound on inspection:

- **Authentication:** `startServer()` supplies a locally generated public JWKS to the real `createAccessVerifier`; tokens are genuinely signed. The harness does not weaken verification settings. Its scenarios use valid credentials, so negative authentication coverage remains in the existing worker tests.
- **Lost response:** the socket is destroyed after `app.fetch()` completes. The test checks for a durable operation commit before retrying, then requires `already-applied`, the same commit SHA, and one final effect. This models a lost server-to-client response.
- **Exact content:** desktop files are read with fatal UTF-8 decoding and BOM preservation, without trimming or newline normalization. Full-string equality is an exact-content check for these valid UTF-8 fixtures, including the CRLF case.
- **Git behavior and scope:** the desktop model uses fetch, merge, and ordinary push; I found no rebase, force push, or explicit side-discarding resolution. The branch diff contains only the allowed harness, report, lockfile, and TypeScript-reference changes. W5 is satisfied structurally in this model by having no Drive dependency; it supplies no evidence about the real Windows worker.

This was a read-only source and diff review. I did not rerun the tests or mutation checks because they create and modify files; the reported execution results remain report-derived.

VERDICT: PASS WITH FIXES
