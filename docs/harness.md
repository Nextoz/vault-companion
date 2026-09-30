# Deterministic worker harness — H1

The coordinator runs trusted code against an untrusted, separate clone.
Routing and escalation remain in [orchestration](orchestration.md#escalation-rule).
High/critical work needs independent Claude review; an implementer's handoff is not review evidence.
**Risk floor — TODO for Evgeny**
<!-- Candidates, not active policy: persistence/identity, new write targets, secrets, harness/config changes. -->

## Trust and invocation

Run `node C:/Dev/vault-companion/tools/harness/verify-run.mjs CLONE ENVELOPE [DISPOSITION]`.
The code's checkout is the coordinator; CLONE must be separate and non-overlapping.
ENVELOPE and optional DISPOSITION must physically reside in the coordinator, outside CLONE.
Use `.agent/harness/` for these local Lead-owned files. Never copy worker evidence there blindly.
Filesystem ownership is the trust boundary: keep workers unable to write the coordinator.
H1 does not authenticate a human or sandbox tests; repository tests/configuration execute code.
Use isolated credentials and externally provisioned tools; do not expose secrets to worker tests.

## Envelope v1

Required fields: `version:1`, `taskId`, `riskClass`, `baseCommit` (full ancestor commit SHA),
`allowedPaths`, `allowedProtectedPaths`, `mayEditTests`, `mayEditCI`, `mayAddDependencies`,
`requiredChecks`, `maxCorrections` (0–20). Unknown fields and malformed values fail closed.
Paths are exact case-sensitive repository paths, or a directory followed by `/**`.
Absolute paths, traversal, backslashes, ambiguous Windows names and symlink paths are refused.
Each check is `{ "argv": [...], "timeoutMs": 18000 }` (maximum 300000 ms).
Allowed argv: `["pnpm","exec","vitest","run","path/to/file.test.ts","--reporter=dot"]`
(one or more explicit test/spec files), or `["pnpm","-r","exec","tsc","--noEmit"]`.
No envelope shell command is executed. pnpm comes from the coordinator's installed toolchain.
The verifier executes checks, bounds output/time, kills timed-out process trees and records status.
Checks run only after all policy findings are clear or explicitly dispositioned.

## Scope and weakening

The scan includes committed changes since base, index/worktree changes, and all untracked files,
including files hidden by worker-controlled ignore rules. `.gitignore`, `.git/info/exclude` and
global excludes cannot hide source. Hidden-index flags are refused; configured Git clean/process
filters are disabled during evidence collection. Receipts are written outside the worker clone, in the coordinator.
No runtime-artifact path is dropped from the untracked candidate set. `node_modules/`, any
`build`/`dist` segment, `*.log`, and similar names are scanned like any other untracked file, so
hidden source under `src/build` or a log and new/modified runtime dependencies cannot evade scope.
No clone `.gitignore`, Git config or worker-selected exclusion is honored. Realistic preinstalled
clones are therefore integration-blocked until a coordinator-owned baseline attests exact
preinstalled runtime files, contents and symlink targets; post-worker contents are never baselined
as trusted. Fixed explicit coordinator-owned output slots may later be bounded, but are not
implemented as broad name/segment exemptions.
Protected paths include Claude settings, harness code/docs, GitHub/CI, lint/test/type configs,
package manifests/scripts, lockfiles, workspace configuration, policy files and `.gitleaksignore`.
Protected permission is path-scoped and never overrides the test/CI/dependency booleans.
Added skip/focus/todo/conditional forms, removed/count-reduced tests, existing-test modifications,
CI/config edits and added ignore entries produce findings. Pattern detection is conservative.
Modified existing specs need disposition even if a text-pattern detector misses an alias or table row.
New dynamically constructed tests can defeat pattern counting; independent review remains necessary.
Lead dispositions may clear only marked conservative findings, never scope/protection/boolean failures.

## Receipts and dispositions

JSON verdict goes to stdout; a short Markdown failure packet goes to stderr; exit is 0 or 1.
`.agent/receipts/<runId>.json` in the coordinator records metadata only: base/head/diff digest,
paths/findings, check argv/status, elapsed milliseconds, corrections and backend/model/effort/risk.
Unknown backend/model/effort/tokens are null; no source, task text, credentials or command output is stored.
Copy the verdict's `binding` unchanged into a Lead disposition with `version:1`, `issuer:"Nextoz"`,
`findingIds`, `corrections`, `backend`, `model`, `effort`, `tokens` (nullable metadata).
The binding includes envelope digest as well as task/base/head/diff; any change invalidates it.
The Lead supplies the correction count; this core is not an automatic retry/resume controller.

## Hooks

Repo settings pin Node at `C:/Program Files/nodejs/node.exe` and quote the fixed `C:/Dev/vault-companion/tools/harness/hook.mjs` path.
They become operational after the trusted scripts are integrated there; clone code is never the gate.
On Linux, the Lead must install an equivalent fixed trusted path; Windows paths are not auto-rebased.
SessionStart injects <2000 characters: branch, tracked-change count, checkpoint Exact next actions,
PR numbers and (only with `HERDR_ENV=1`) Herdr agent IDs. Timeouts fall back without blocking.
Checkpoint prose is labelled untrusted; PR titles/bodies and agent prose are not injected.
Write/Edit deny vault/reference destinations after ancestor symlink/junction resolution; reads are allowed.
Outside canonical main, protected file edits and non-policy ConfigChange are denied.
The canonical location is a code constant, not an environment override; policy settings are exempt.
Bash/PowerShell/Pwsh patterns refuse recognizable force pushes, remote repointing and history rewrites
on every branch (including unknown/main). No Stop hook or `stop_hook_active` dependency exists.
Shell parsing is best effort: aliases, encoded/dynamic commands, shell redirection and other write tools
can evade patterns. Native Windows Claude has no OS sandbox supplied by these hooks.

## Merge gate and remaining integration

Use literal `gh pr merge NUMBER --repo OWNER/REPO [--squash|--merge|--rebase] [--delete-branch]`.
The hook only permits/denies; it never merges. Ambiguous/wrapped commands are refused when recognized.
Lead evidence lives at `.agent/harness/merge/OWNER/REPO/NUMBER.json` in the trusted coordinator.
See [evidence schema/example](../tools/harness/merge-evidence.example.json) and [ADR-0031](decisions/0031-deterministic-worker-harness.md).
Merge `diffDigest` is SHA-256 of the raw GitHub PR diff response, distinct from the local verifier digest.
Require bound current review/dispositions, required green CI, no hold, no unresolved owner threads,
no owner CHANGES_REQUESTED, and explicit later responses/dispositions for Nextoz issue comment IDs/URLs
and standalone COMMENTED reviews (`ownerResponses[].reviewId`, with a later `at` and response reference).
Incomplete/paginated API evidence, absent branch-protection checks or API failure deny; receipts cannot override red CI/hold.
H2 will add Codex JSON rendering/resume, launch profiles and a continuous watcher.
H1/H2 remain held until independent Claude review and live hook canary after reset; fixture success is not H acceptance.
