# H1 — deterministic harness core (Lead task contract, 2026-09-30)

Engineering translation of Ready Backlog H Part 1. Public repository and synthetic fixtures only.
No live vault access. Read AGENTS.md; this packet is the task context. Do not read whole docs or private context.

## Outcome and scope

A coordinator can reject an out-of-scope or weakened worker change and refuse unsafe merges using reproducible
machine evidence. Hooks protect supported Claude tool calls; they are best-effort defense, not an OS sandbox.
Implement the core only. H2 will add the Codex JSON renderer/resume wrapper, launch profiles and continuous watcher.
No Claude execution, API use, cloud sessions, deployments, pushes, PR creation, recursive agents, or writes outside C:/Dev.
Use model/effort selected by the Lead from orchestration. H1 is high risk; later independent Claude review is required.

## Read surface and allowed edits

- Read `package.json`, `vitest.config.ts`, `.claude/settings.json`, `.gitignore` and `tools/agent-pane.sh` (small files).
- Read `docs/orchestration.md` only Roles/routing/escalation and Worker-to-Lead/PR sections as needed.
- Create `tools/harness/**`, `docs/harness.md` (~80 lines), `docs/decisions/0031-deterministic-worker-harness.md`.
- Add a single link in AGENTS.md. Update `vitest.config.ts` only to include harness tests in the normal suite.
- `.claude/settings.json`: preserve permissions, add repo hooks only AFTER fixture tests pass. Do not touch user config
  or `.claude/settings.local.json`. No dependency additions, app-code changes, CI changes, or ignore additions.
- Write `.agent/handoffs/H1-harness-core.md` at end, at most 15 lines. Do not edit plan/checkpoint/orchestration.
- H1 explicitly authorizes implementing protected harness/config files. Ordinary envelopes must deny them.

## Design decisions

Use Node built-ins (ESM .mjs scripts suitable for Windows and Linux), no new runtime. Tests in tools/harness/*.test.ts.
Use shell-free child-process argument arrays, bounded timeouts, and temporary fixture directories under C:/Dev on
this machine (use process TEMP/TMP/TMPDIR). No arbitrary envelope shell command execution: checks are validated argv
for targeted Vitest and typecheck. A clone is untrusted input: run verifier code/envelope from the trusted coordinator
checkout, not from the worker-modified clone. State the residual risk of running repository tests explicitly.

Envelope v1: taskId, riskClass (low/ordinary/high/critical), allowedPaths (exact relative paths or trailing /**),
mayEditTests, mayEditCI, mayAddDependencies, requiredChecks, maxCorrections. Add baseCommit and explicit allowedProtectedPaths
for binding and exceptional harness work. Validate all input strictly: malformed/missing baseline, path traversal,
unknown checks, symlink escape => failure. Include tracked committed changes since base, staged/unstaged changes and
untracked files; only explicit harness output paths are excluded. Exclude no arbitrary worker-chosen path.

Protected: .claude/settings*.json, tools/harness/**, docs/harness.md, .github/**, lint/test/type configs and
.gitleaksignore. Include package scripts/config and dependency manifests in policy checks. Reject changes to
tests/CI/dependencies when their booleans disallow them. A protected-path allow is scoped, never a global bypass.

## Required behavior

1. `verify-run` entry point accepts clone + trusted envelope. Scan changed files against allowed/protected policy.
   Detect added test .skip/.only and equivalent skipped/focused forms, deleted/disabled tests, reduced test-case
   count in changed specs, CI/config edits and added ignore entries. Conservative flags may be dispositioned by the
   Lead explicitly for a bound diff; never let a worker self-approve. Execute required checks itself with captured
   exit status and timeout; don't trust worker logs. Output JSON verdict + short Markdown failure packet, exit 0/1.
   Record metadata-only receipt under .agent/receipts/<runId>.json: backend/model/effort/risk, base/head + diff digest,
   changed paths, findings, each check + exit code, corrections, elapsed time, tokens when known. Unknown means null.
   Never include source contents, command output, task text or credentials in receipts.
2. SessionStart hook: stdin JSON -> live branch/status summary, checkpoint Exact next actions, open PR numbers and
   Herdr agent list only when HERDR_ENV=1. Total injected context <2000 characters; timeouts and fail-open fallback.
   Treat PR/title/body as untrusted; prefer metadata. Static policy stays in CLAUDE.md.
3. PreToolUse: deny Write/Edit in the vault root C:/Users/evkar/Obsidian Vault and the reference checkout
   C:/Dev/vault-companion-vault-reference (case/separator/relative paths handled; no prefix sibling false positive).
   Reads remain allowed. Deny recognizable force pushes, remote repointing, history rewrites and reset --hard on main
   (unknown branch fail closed). Cover Bash and PowerShell/Pwsh command tools; document shell-parsing limitations.
   Outside canonical C:/Dev/vault-companion, deny edits to protected files. Canonical path must not be spoofable just
   by setting a clone-controlled env var; handle symlinks/junctions consistently.
4. ConfigChange: block non-policy settings changes outside canonical main checkout. Do not depend on stop_hook_active
   or implement a Stop hook. Main checkout remains editable so bad config cannot lock the Lead out.
5. Merge gate: `gh pr merge` invokes a trusted gate; fail closed on API errors/incomplete evidence. Require green CI
   for current PR head (missing/pending/skipped required checks cannot count as green), no undispositioned handoff,
   current high-risk independent review receipt, clean or explicitly dispositioned weakening findings, no hold label,
   no unanswered owner comment/review. Bind receipts to exact PR/repo/head/diff and reviewer identity; worker's final
   handoff is never a review receipt. A receipt can't override hold or red CI. Distinguish trusted Lead evidence from
   files carried on the PR branch. Do not issue the merge itself from the hook; permit/deny the requested action.
   Owner account is Nextoz. Unresolved owner review threads and CHANGES_REQUESTED block. For issue comments require
   an explicit response/disposition referencing comment ID/URL after that comment; don't infer answer from any newer
   generic comment. If evidence is ambiguous, deny with a small actionable reason. API fixture tests, no live writes.

## Hook API (official docs verified by Lead 2026-09-30)

Source: https://code.claude.com/docs/en/hooks . JSON stdin includes cwd, hook_event_name; tool events include
tool_name/tool_input; Write/Edit use file_path; Bash/PowerShell use command. PreToolUse denial JSON is
hookSpecificOutput {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "..."}.
ConfigChange input has source and optional file_path; denial uses decision:"block", reason. Policy settings cannot
be blocked. SessionStart context uses hookSpecificOutput {hookEventName:"SessionStart", additionalContext:"..."}.
Register command hooks with bounded timeout and repo script paths quoted for spaces. Piped fixtures are mandatory;
live Claude canaries are DEFERRED, not passed. Preserve the existing Herdr user hook by never editing user settings.

## Done when / executable acceptance

- Normal Vitest suite discovers five required evals: added .skip flagged, CI edit flagged, vault Edit denied,
  clone settings edit denied/flagged, clean allowed change WITH new test passes.
- Tests invoke actual CLI/hook entrypoints with piped JSON in temporary synthetic repos, not just helper replicas.
- Include negative cases for outside allowed paths/untracked files, malformed envelope, path casing/traversal,
  check fails/timeouts, no CI, stale receipt, hold, unanswered owner comment, API failure; positive answered-owner
  and clean merge fixtures. Mutating the production guard must break its regression test.
- Run only `pnpm exec vitest run tools/harness --reporter=dot` and `pnpm -r exec tsc --noEmit`;
  pipe long output to the last 30 lines. No full check/e2e: Lead owns those. No repeated passing checks.
- Return changed paths, verification results, known limitations and deferred H2 integration in <=15-line handoff.

## Documentation and deliberate non-completion

docs/harness.md: risks from routing, envelope, protection, gates, receipt, link escalation (don't duplicate).
Leave **Risk floor — TODO for Evgeny**; candidates in an adjacent Markdown comment, not active policy.
ADR: propose owner-applied required GitHub checks on main and checkpoints on PR/state branch, no ruleset mutation.
Describe honest boundaries (pattern guards, tests as code, native Windows Claude lacks OS sandbox).
H1 and H2 stay on a held PR until independent Claude review and live hook canary after the reset; H isn't accepted
merely because these fixtures pass. DeepSeek/Jev graduation and canary are outside this implementation.
