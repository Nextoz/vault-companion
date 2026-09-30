# Harness launch profiles, Codex events/resume and watcher — H2

Companion to `docs/harness.md` (H1). H2 adds the launch layer: visible Codex workers that emit JSON
events and a structured handoff, invoke the trusted post-run verifier, and perform one bounded
correction by resuming the real session ID. A continuous watcher wakes the current Lead. All writes
stay in this `C:/Dev` clone and `C:/Dev` tool homes; the live vault is never read or written.

## Files

- `tools/worker-launch.mjs` — trusted launcher: validates the envelope, launches Codex with `--json`,
  invokes the trusted verifier, and bounds corrections with `codex exec resume <session>`.
- `tools/worker-events.mjs` — streams Codex JSONL into `clone/.agent/events.jsonl` and prints only
  sanitized metadata summaries. Malformed lines are preserved, never rendered.
- `tools/worker-watcher.mjs` — deduplicating, bounded-polling Lead watcher (see Signals below).
- `tools/start-lead.ps1` / `tools/start-worker.ps1` — pinned launch-profile generators.
- `tools/profiles/` — pinned, minimal launch configs and the public-only handoff schema.
- `tools/wait-for-work.sh` — now a thin CLI-compatible wrapper over `tools/worker-watcher.mjs`.

## Launch a worker (visible pane)

```sh
AGENT_USER_ENV=DEEPSEEK_API_KEY bash /c/Dev/vault-companion/tools/agent-pane.sh "deepseek-flash-high · <task>" <clone> <clone>/.agent/run.log \
  node /c/Dev/vault-companion/tools/worker-launch.mjs --clone <clone> --envelope <envelope> \
    --provider deepseek --model deepseek-flash --effort high \
    --sandbox workspace-write --codex-home C:/Dev/tools/vault-companion-codex-home --coordinator C:/Dev/vault-companion
```

The envelope is the H1 envelope v1 (`docs/harness.md`) and must live in the trusted coordinator,
outside the worker clone. `DEEPSEEK_API_KEY` is read from the Windows User scope at run time by
`agent-pane.sh` and is never printed. The launch and docs invoke the coordinator's absolute
`tools/agent-pane.sh` and `tools/worker-launch.mjs` scripts, never the worker clone's relative paths.
DeepSeek model IDs are `deepseek-flash` (Flash, the default tier) and `deepseek-v4-pro` (Pro).

## Verifier coupling and blocked state

`worker-launch.mjs` refuses to launch when the trusted verifier at
`C:/Dev/vault-companion/tools/harness/verify-run.mjs` is missing and reports `integration-blocked`;
it never claims acceptance. Until the H1 core is integrated into the canonical coordinator, H2 stays
blocked by default. `--verifier` may point at a coordinator-owned copy, but H1's `coordinator`
constant is fixed to its checkout, so its envelope location check rejects envelopes owned by another
checkout — this is the concrete coupling that must be resolved during H1 integration. A verifier
realpath inside the worker clone (including symlink/junction escapes) or a `--coordinator` override
pointing into the clone is refused before any launch.

## Correction policy

Only a worker that completed (Codex exit 0) but was refused by the verifier is eligible for a
correction. Up to `maxCorrections` resumes are attempted with the verifier's failure packet; the
session ID is taken from the event stream. Quota, provider, credential, model and tooling failures
are never escalated as reasoning corrections.

## Receipts

Metadata-only receipts are written to `coordinator/.agent/receipts/<runId>.json`: backend/model/effort,
risk, changed files, verdict, exit codes, correction count, nullable duration/tokens. No task text,
secrets, commands or tool payloads.

## Watcher signals

New `agent/*` branches, completed CI, CodeRabbit activity, owner (Nextoz) comments/reviews on open PRs,
hold-label removal, Ready Backlog mtime changes (mtime only, never contents), finished worker logs,
and new `.agent/handoffs/*.md` files. Wakes the explicit `HERDR_LEAD_PANE` with `WAKE: <metadata>`
via `herdr agent prompt` (submitted work, not raw pane text) and never focuses another pane.

## Tests

```sh
pnpm exec vitest run --config .agent/vitest.tools.config.ts tools/worker-launch.test.ts tools/worker-events.test.ts tools/worker-watcher.test.ts --reporter=dot
```

`tools/**/*.test.ts` is outside the current Vitest `include`; H2 uses the temporary
`.agent/vitest.tools.config.ts` (never the shared `vitest.config.ts`) and the H1 test-discovery
integration still needs to add `tools/**/*.test.ts`. H2 is not self-certified: it remains held for the
independent Claude review and live canary, as does H1.
