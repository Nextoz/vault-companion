# ADR-0031: deterministic worker harness core

Status: proposed; H1 implementation requires independent Claude review and a live hook canary after reset.
Date: 2026-09-30

## Context

Worker summaries and passing logs cannot prove scope compliance or safe integration.
A worker can weaken tests, edit configuration or hide files while claiming success.
Local Claude command hooks are useful defense in depth but are not an OS security boundary.

## Decision

Use Node built-ins and shell-free argument arrays for a trusted coordinator verifier, bounded checks,
Claude SessionStart/PreToolUse/ConfigChange hooks, and a read-only GitHub merge gate.
Run coordinator code and envelopes outside the worker clone. Resolve physical paths and reject traversal,
symlink escapes, unsupported objects and missing baselines. Scan committed, index, worktree and untracked
changes, including files hidden by worker ignore rules. Do not exempt worker-selected output paths.
No untracked runtime-artifact path is exempted by name/segment. `node_modules/`, any `build`/`dist`
segment, `*.log`, and similar names are scanned, so source hidden under `src/build` or a log and
new/modified runtime dependencies fail closed. No clone `.gitignore`, Git config or worker-selected
exclusion is honored. Realistic preinstalled clones are integration-blocked until a coordinator-owned
baseline attests exact preinstalled runtime files, contents and symlink targets; post-worker contents
are never baselined as trusted. The fixture suite asserts newly ignored source and hidden
`src/build`/log/runtime paths remain detected while tracked runtime paths are still refused when out of scope.

An envelope grants exact or directory-scoped paths, separate protected-path exceptions and explicit
test/CI/dependency permissions. Test weakening and configuration findings are conservative. Only trusted
Lead dispositions bound to the exact envelope/base/head/diff can clear dispositionable findings.
Required checks execute locally; test/configuration code remains arbitrary code with the caller's access.
Bounded execution and process-tree termination are operational controls, not credential isolation.

Receipts contain metadata, never command output/source/task prose. Backend/model/effort/tokens are null
unless supplied by the Lead. The Lead supplies correction counts until H2 owns retries/resume state.
Check execution must not mutate the inspected state: a changed snapshot after checks refuses acceptance.

Repository hook registrations use a fixed quoted canonical script path, not a clone-controlled environment
variable or a relative worker script. The canonical checkout remains editable; outside it protected writes
and non-policy settings changes are refused. Managed policy settings cannot be blocked. No Stop hook.
Recognizable dangerous Git commands are denied on all branches, a conservative superset of main-only
protection that also covers unknown branch state. Shell aliases, obfuscation, redirection and unsupported
tools remain bypasses; native Windows Claude gains no OS sandbox from this implementation.

Merge evidence is read from the trusted coordinator, never PR-branch receipts. Bind repo/PR/head/diff,
review identity, seven-day freshness/expiry and Lead dispositions. A high/critical independent review must
be Claude, approved, and by an identity distinct from the PR author and recorded implementers.
The Lead is responsible for identity attestation and completeness of the weakening-disposition ledger;
this is not a cryptographic signature system. Changed handoff files must have matching dispositions.

Read GitHub PR state, required branch-protection contexts, current-head check rollup, labels, comments,
reviews, unresolved threads, changed files and diff. Recheck head after collection. Refuse truncated
connections (100-item boundary) rather than silently accepting missing evidence. Missing branch protection
or inaccessible APIs also refuse. All reported checks must succeed: skipped/neutral/pending are not green.
Do not infer an answer to an owner comment from a newer generic comment: require a later explicit
Lead response/disposition referencing its ID or URL. Holds/red CI cannot be dispositioned away.
The gate does not merge. GitHub may change after the hook returns; server-side enforcement is essential.

## Proposed owner actions (not performed)

The owner should apply required GitHub checks on main, including harness fixtures and the existing CI,
and require review/current-head checks at merge. No ruleset or branch-protection mutation is in H1.
Move resumable checkpoints to the relevant PR/state branch so coordinator state is explicit and reviewable.
The owner chooses a risk floor later; candidates in harness documentation are comments, not active policy.

## Validation and deliberate non-completion

Offline synthetic repositories exercise actual CLI entrypoints and piped hook JSON; API fixtures exercise
the merge gate. No live vault, Claude execution, cloud sessions, deployment or remote writes are needed.
Run only targeted harness Vitest and workspace TypeScript checks here; the Lead owns full check/e2e.
Keep H1 and H2 held for independent Claude review plus live hook canary after reset. H2 supplies the Codex
JSON renderer/resume wrapper, launch profiles and continuous watcher.
