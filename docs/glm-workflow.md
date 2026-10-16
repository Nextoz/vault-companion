# Standalone GLM workflow

`tools/glm-workflow.mjs` owns the guarded OpenCode process and FIFO task queue.
`tools/glm-supervisor.mjs` runs a finite manifest without Codex or an interactive terminal.
Both use the same machine-wide single-worker lock. The workspace lock resolves aliases,
and queue state changes use a separate short cross-process lock.

## Run and inspect

Use Node 24 with OpenCode v2 installed. Supply `SCW_SECRET_KEY` and `SCW_PROJECT_ID`
to the parent process at runtime. Never put keys in a manifest or prompt.

```powershell
node tools/glm-supervisor.mjs run C:/absolute/manifest.json C:/absolute/state-home
node tools/glm-supervisor.mjs status C:/absolute/state-home
node --test tools/glm-workflow.test.mjs tools/glm-supervisor.test.mjs
```

The state home must be outside the worker workspace. The run can be started with
`Start-Process -WindowStyle Hidden`, with stdout/stderr redirected to local files.
No scheduler, Codex heartbeat, or open chat is required. Closing the chat does not
terminate a detached process; closing Windows or killing its process can interrupt it.

## Acceptance and recovery

Each manifest job has exact application-source paths, exact test paths, three briefs,
and allowlisted check names. The sequence is developer, separate test analyst,
deterministic local checks, then a fresh read-only GLM reviewer snapshot. Workers
cannot approve themselves. Approval requires strict JSON with `verdict: "pass"`
and an empty findings array. Test failure or review findings allow at most one repair,
then checks and a new independent review. Malformed reviews stop immediately.

Controller state, check output, reviews and per-request reservation counters are
written atomically. A restarted controller refuses any existing state, including an
interrupted run; an operator must inspect partial changes before starting a new manifest.
Corrupt state never becomes an empty queue. Existing snapshots and source changes are
preserved. Queue recovery is explicit and does not implicitly clear quota circuits.

## Guardrails and limits

- One active worker across controllers and queue runners; one provider request at a time.
- Fixed Scaleway GLM-5.3 endpoint, loopback proxy nonce and `vc-scaleway` provider alias.
- Upstream credentials stay in the parent; credential-like environment variables are
  removed from worker/check processes. Reviewer snapshots skip secrets/config/generated
  directories and reject source symlinks; post-run hashing detects reviewer writes.
- OpenCode permissions deny shell, subagents, web access, external directories, and
  writes except exact assigned files. These are harness policies, not an OS sandbox.
- A temporary root `opencode.json` supplies the verified v2 configuration and is restored
  byte-for-byte on normal completion, handled errors and timeouts. Conflicting project
  configs are rejected. An uncatchable parent crash may require manual config recovery.
- Every upstream attempt is reserved before sending and persisted; failed/unknown usage
  keeps conservative reservations. Token estimates use UTF-8 bytes, not a tokenizer.
  Live quota ceilings plus local rolling windows constrain requests; bounded local waits
  let a rate window reset. No account-wide quota or monetary-balance guarantee is claimed.
- Each worker: at most 20 upstream attempts, 1M cumulative token reservations, six minutes,
  and 4,000 output tokens per call. Defaults for manual queue tasks remain downward-bounded.
- Each controller: at most four jobs, 60 attempts, 3M reservations, 300k known actual tokens,
  and 45 minutes. Actual usage is checked after replies; one in-flight reply can cross that
  threshold, while the pre-send reservation limit remains hard. Unknown usage stops the
  controller for inspection. These are spending bounds, not euro credit monitoring.
- Temporary provider errors get at most two retries; auth/quota/billing/ambiguous-quota
  responses stop immediately. Client retries cannot bypass session counters or a circuit.
- Local checks use fixed executable arguments with timeouts and process-tree termination.
  No model-generated commands, Git publishing, merges or deployments run in the controller.

## Evidence

Offline tests cover actual HTTP proxy behavior, concurrent queue writers, locking,
configuration restoration, reviewer mutation detection, durable accounting, and the
controller's acceptance/stop paths. A separate live GLM review and a process/state read-back
are needed before claiming a particular launch succeeded. Current evidence and task state
belong in `docs/checkpoint.md`, not this policy document.
