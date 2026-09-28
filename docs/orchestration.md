# Orchestration and model routing

Durable policy for multi-agent work on this repository (owner instruction, 2026-09-24).
Full background: bootstrap §5–7 in `docs/bootstrap/`.

## Roles

- **Lead: Claude Opus 5.5** (`claude-opus-5-5`). Owns architecture, decomposition, task contracts,
  integration, conflict reconciliation and final technical decisions. Never delegated.
- Workers and reviewers run with bounded briefs. Claude/local workers normally use separate worktrees under
  `C:\Dev\vault-companion-worktrees\`; Codex uses disposable full clones under
  `C:\Dev\vault-companion-clones\` because its workspace sandbox cannot write a worktree's shared `.git`.
  Implementation workers hand off through `.agent/handoffs/`; dedicated reviewers write `docs/reviews/` when a durable review is required.
- Concurrency is budgeted, not unlimited: **one Codex worker by default** (maximum two only when the Lead records that
  the tasks are independent and the speedup is worth the quota), **one Claude worker at a time**, and **one Playwright
  job at a time**. Never run two Astra-high jobs in parallel. Free/local workers are additionally limited by RAM and
  provider quotas. No recursive spawning unless the Lead explicitly delegates it.
- An implementation agent never certifies its own high-risk milestone.

## Current model routing — single source of truth

This section is the **only active routing table**. Dated usage observations later in this document explain why the
policy exists; they do not override it. Model availability changes, so every launch still verifies the model and
reasoning effort from the worker banner/log.

OpenAI's current Codex availability for the owner's Plus account includes GPT-5.6 Luna, Terra and Sol plus GPT-6
Astra. Route to the **cheapest model reasonably capable of passing the brief and acceptance checks**:

| Task | Default worker/model |
|---|---|
| Tiny deterministic edit: rename, one-line fix, docs/formatting | Free/local worker when suitable; otherwise Codex `gpt-5.6-luna` **low** |
| Clear bounded task: focused test, small UI/CSS, simple bug, coordinated edits from a precise brief | Codex `gpt-5.6-luna` **medium** |
| Moderate debugging or multi-file change with a clear contract | Codex `gpt-5.6-terra` **medium** |
| Ordinary implementation/integration requiring engineering judgment | Codex `gpt-5.6-sol` **medium** |
| Difficult diagnosis or deep review without a critical integrity/security boundary | Codex `gpt-5.6-sol` **high** |
| Concurrency, identity, persistence/data-integrity, security/privacy, or other genuinely high-risk work | Codex `gpt-6-astra` **medium** |
| Critical adversarial review of a new write target, realistic data-loss/identity bug, or unresolved high-risk invariant | Codex `gpt-6-astra` **high** |
| Substantial self-contained feature when Codex is unavailable | Claude Code Cloud; Sonnet by default, Opus only for critical core work |

Free/local workers (Gemini, Antigravity, Qwen) may replace Luna/Terra only for bounded low-risk public-repo work; their
operational constraints are below. The **Lead remains Claude Opus 5.5** and keeps architecture, decomposition,
integration, conflict reconciliation and final acceptance.

### Escalation rule

1. Start at the lowest tier that should reasonably pass given the task's ambiguity and risk.
2. Give it one proper attempt. If verification exposes a clear implementation mistake, allow one focused correction
   at the same tier.
3. Escalate **one tier** only when the evidence shows the task needs more reasoning, broader context or stronger review.
4. Never escalate because of a rate limit, unavailable model, missing access, broken tooling, flaky test, dependency
   problem or under-specified brief. Fix/reroute the blocker instead.
5. Astra-high requires a one-line risk reason in the brief. "Seems difficult" is not a risk reason.
6. Do not duplicate implementation across models except for a deliberate independent comparison or review.

### Launch rules

Always pass the model and effort explicitly; never rely on CLI defaults. Examples:

```sh
codex exec -m gpt-5.6-luna  -c model_reasoning_effort=medium …
codex exec -m gpt-5.6-terra -c model_reasoning_effort=medium …
codex exec -m gpt-5.6-sol   -c model_reasoning_effort=medium …
codex exec -m gpt-6-astra   -c model_reasoning_effort=medium …
```

All Codex repo workers also disable memories:
`-c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false`.

Verify `model:` and `reasoning effort:` in the log before substantial work. If a model is unavailable, record that
fact and consciously reroute; never silently substitute.

## Sources of truth and vault access (owner, 2026-09-26; ADR-0018)

- **Priority and product decisions:** the owner's vault note `Projects/Vault Companion/Vault Companion - Ready
  Backlog.md`. The Lead reads it (read-only) before choosing work and never edits it.
- **Engineering status:** `docs/plan.md`, written only by the Lead; it links to the Ready Backlog, not copies it.
- **Live vault reads:** the local Lead only, read-only, paths per ADR-0018. Workers of any kind (Cloud, Codex,
  Antigravity, Qwen, Jev) never touch the live vault; their briefs are synthetic, with shapes derived by the Lead.

## Visible agents (owner, 2026-09-26)

Every non-interactive worker starts through `tools/agent-pane.sh` so the owner can watch it live:
one labelled pane per agent (`<model>-<effort> · <task>`) in the **Agents** tab (created on demand, never focused),
output streamed in the pane and tee'd to the log, pane closes itself 60 s after the command ends (the tab closes with
its last pane). Codex runs add `-c model_reasoning_summary=concise -c model_verbosity=low -c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false` so reasoning summaries are visible.

```sh
AGENT_STDIN=<clone>/.agent/brief.md bash tools/agent-pane.sh "astra-high · pr18" <clone> <clone>/.agent/run.log \
  codex exec -m gpt-6-astra -c model_reasoning_effort=high -c model_reasoning_summary=concise -c model_verbosity=low -c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false \
  --sandbox workspace-write -C <clone> -
```

**Codex memories OFF for repo workers (owner, 2026-09-27):** the owner's global Codex memory (~200 KB, vault-related
personal notes) was being loaded into worker context — a privacy boundary we do not want and a large token cost. Always
pass the three memory overrides above; verify on the first run after a quota reset. Worker logs in the clones are
deleted once their PRs merge (they may contain such context); they are never committed.

**Token economy (owner, 2026-09-26, tightened 2026-09-28):** measured 59k tokens for a 10-line fix and
95–130k per review, mostly from whole-doc reads and repeated full `pnpm check` runs. Briefs are self-contained: quote
the finding, name files + line ranges, and never tell a bounded worker to "read docs/…" broadly. Workers follow the
AGENTS.md token rules; the Lead runs the full check/e2e before merge. Use the routing table above and escalate only on
evidence.

**Antigravity (agy 1.2.11):** `-p -` with a stdin brief sometimes starts with an empty prompt ("How can I help you
today?"). Pass the prompt as text instead: `agy.exe -p "Read the file .agent/brief.md in the current directory and carry
out that task exactly as written." --model gemini-3.8-flash-medium --dangerously-skip-permissions` (still via
`AGENT_STDIN=… bash tools/agent-pane.sh`). First results: dup-row test good but fix removed an identity guard (held);
O11 CSP smoke good and found a real Zod CSP violation (PR #23). Review its diffs like any worker's.

Wait for completion with the log's last line (Codex: `tokens used`) rather than polling the pane.

**Conflicting PRs run no CI (2026-09-28):** GitHub cannot build the test merge, so `pull_request` workflows never queue and
the checks list shows only CodeRabbit. After every push run `gh pr view <n> --json mergeStateStatus`; `DIRTY` ⇒ merge
`origin/main` into the branch, rerun the check, push again.

**Parallel Playwright hazard (2026-09-27):** apps/web/playwright.config.ts uses reuseExistingServer locally, so two clones
running e2e at once share port 4173 and one tests the OTHER clone's build (a triage spec "failed" against a worker's
preview). Run e2e in one clone at a time, or check the port is free (Get-NetTCPConnection -LocalPort 4173) first.

## Herdr mechanics learned (Windows / Git Bash)

- Git Bash rewrites a leading `/word` argument into a Windows path: prefix Herdr calls that send slash
  commands with `MSYS_NO_PATHCONV=1`.
- `herdr agent prompt … --timeout` requires `--wait`; a syntax error exits 2 and sends nothing.
- A reviewer whose context was touched by anything but its brief is replaced, not reused.
- **Never end a Claude agent with `/exit`** (Claude Code ≥ 2.1.282): it moves the conversation to a
  background-sessions dashboard, and any text later sent to the pane *starts a new background session*.
  The dashboard also lists the owner's unrelated sessions and `ctrl+x` deletes the selected one — do not
  navigate it. To retire an agent, `herdr pane close <pane-id>` on a pane the Lead created, and start new
  agents in fresh panes.
- Worker panes: `herdr pane split --pane <id> --direction down|right --cwd <worktree> --no-focus`, then
  `agent start`; confirm the model from the startup banner (`Opus 5.5`) before prompting.
- Hand briefs/diffs over as files; reviewers reply with a one-line verdict and write details to a file.
- **Codex in Herdr (Windows, codex-cli 0.154):** interactive `codex` first shows a *"Do you trust the contents of
  this directory?"* dialog that Herdr reports as `idle` (not `blocked`); a prompt sent then answers the dialog and
  quits Codex. Do not trust directories on the owner's behalf. Instead run bounded Codex tasks non-interactively
  inside a Herdr pane: `herdr pane run <pane> "Get-Content -Raw <prompt-file> | codex exec -m gpt-6-astra
  --sandbox workspace-write -C <repo> - 2>&1 | Tee-Object -FilePath <log>"` (log is UTF-16 under PowerShell 5).
  Verify `model:` in the log header. The owner may choose to trust the repo once to enable interactive agents.

## Resumability (owner requirement, 2026-09-24)

Progress must survive usage limits, Herdr restarts, compaction, sleep and reboot. Conversation context is never
the only record.

- `docs/plan.md` always states: active milestone, done, in progress, delegated agents (pane, branch, commit),
  unresolved issues, failed QA, and **exact next actions**.
- `docs/checkpoint.md` is overwritten (not appended) at stable points and before any long pause, compaction or
  usage-limit boundary: completed, remaining, risks, branches/worktrees, tests run + results, exact next action.
- Commit at every stable checkpoint; never accumulate a large uncommitted tree. Workers commit on their branch
  before being idle or retired; a worktree is removed only after its branch is merged or recorded as abandoned.
- Consequential decisions go into ADRs, not only into conversation.
- If usage is about to run out: stop at a safe point, commit, update plan + checkpoint, leave no half-applied edit.

### Resume procedure (any Lead, fresh context)

1. `git status`, `git log --oneline -15`, `git worktree list`, `git branch -vv`.
2. Read `docs/checkpoint.md`, then `docs/plan.md`, then only the ADRs/docs the next action names.
3. `herdr agent list` (inside Herdr) — reconcile with the plan's delegated-agents table; read a worker's report file
   before re-prompting it. Never re-dispatch work whose branch already contains it.
4. Run `pnpm check` to confirm the recorded test state, then continue with the checkpoint's exact next action.
- `MSYS_NO_PATHCONV=1` also disables Git Bash path translation for git: pass Windows paths (`C:/Dev/...`) to git while
  it is set, or `/c/Dev/...` becomes `C:/c/Dev/...` (happened once; empty leftover dirs under `C:\c\` for the owner to delete).
- `codex exec` writes its transcript to **stderr**; under Windows PowerShell 5, `2>&1 | Tee-Object` renders every line
  red as a NativeCommandError even when the run is healthy (owner saw an all-red pane, 2026-09-25). Check the log for
  real `ERROR` lines instead of the colour. For new runs prefer
  `cmd /c "codex exec … - < <prompt-file> > <log> 2>&1"` (plain text, UTF-8 log, no red wrapping).

## Claude Code Cloud workers (owner rules, 2026-09-25)

**Push works only after the owner prompts the session (verified 2026-09-27, D):** a CLI-launched session starts from an
uploaded bundle without a remote even after /web-setup; once the owner writes one line in the session page ("you may
push") it pushes. Workflow: Lead launches -> tells the owner the session link -> owner sends that line -> the Lead
watches for the branch (no branch after 15 min = ask again). Cloud containers have no WebKit: the Lead runs the WebKit
e2e locally before merging.

- Only for bounded, repo-contained tasks: no live vault, Windows-only tooling, Herdr state or local sync. Never send the
  personal vault repository to the cloud. Cloud workers count as workers for concurrency planning.
- Precondition: `git remote -v` shows a GitHub remote for this repo. If not, stop and tell the owner; never create one.
- Precondition 2: the **Claude GitHub App is installed on `Nextoz/vault-companion`** (github.com/apps/claude). Without it
  `claude --cloud` uploads a local *bundle* instead of cloning: the session has no `origin` and cannot push (C and P2-A,
  2026-09-25, finished but never pushed). The launch output should say it is cloning, not bundling.
- **Probe 2026-09-25 14:45:** even with the App installed, a CLI-launched session had no `origin` (bundle upload) and
  could not push. Needed as well: the owner's claude.ai account connected to GitHub with push access — run `/web-setup`
  in a terminal Claude Code session (sends the local `gh` token), or connect GitHub at claude.ai/code. Existing
  sessions recover when the owner approves "attach repository with push access" in the session UI; then the Lead
  sends `claude -p "push now" --cloud <id>`. **Never launch a new cloud task before a probe push succeeds.**
- Every cloud brief says **push early**: a report stub pushed in the first minutes, then the final push. The Lead only
  sees GitHub, never the container; no branch after ~15 min ⇒ ask the session (`claude -p … --cloud <id>`).
- Launch: commit + push the brief, then
  `claude --cloud "Read AGENTS.md, then follow docs/briefs/<brief>.md exactly. Work on branch agent/<name>. Run required tests, write .agent/handoffs/<brief>.md, commit and push the branch early and when done. Do not open a PR or spawn agents." --permission-mode auto`
  — the description must come **directly after `--cloud`** (2026-09-28: `--cloud --permission-mode auto "…"` fails
  with "--cloud requires a description"). The Herdr pane shell is PowerShell: quote the description with `'…'`.
  (`--permission-mode auto`: owner request 2026-09-25, so sessions do not stall on approvals — verify in the session.)
  Record session ID + branch in `docs/plan.md`. Continue a session: `claude -p "<message>" --cloud <session-id>`.
- Finish: `git fetch`, review the branch, run verification locally, merge if accepted.
- First use is one small task to verify the workflow. Verified 2026-09-25 (brief C).
- `claude --cloud` needs an interactive TTY: launch it with `herdr pane run <pane> "claude --cloud '…'"` and read the
  `Created cloud session: … session_<id>` line from the pane.
  Launch **one at a time** and wait for the shell prompt to return before the next: text typed while `claude --cloud`
  provisions is queued as messages to that session (`herdr pane wait-output` also matches old screen text).
- **Routing under Claude-token pressure (owner, 2026-09-25):** most implementation goes to Claude Code Cloud; small or
  low-risk tasks to Codex GPT-6 Astra at effort `low` (`cmd /c "codex exec -m gpt-6-astra -c model_reasoning_effort=low …"`).
  The local Lead stays lean: decompose, review, integrate.
- **Local Qwen** (tiny deterministic tasks, one at a time): `qwen-agent` is installed and verified by the owner (npm
  shim `qwen-agent.cmd`; a `pi`-based agent with read/bash/edit/write). Non-interactive: `cmd /c "qwen-agent -p
  --no-session \"<prompt>\""` in a full clone. Only with **≥ 5 GB free RAM** (the 4B model needs ~3.4 GB).

## Budget observations and alternative backends

These are operational observations and fallback mechanics. They **do not override the current routing table above**.

**Codex budget (owner observation, 2026-09-28):** three parallel runs, including two Astra-high jobs, used roughly
424k tokens in 32 minutes and exhausted the short usage window. A weekly limit was also reached after roughly 540k
tokens one night plus 115k the next morning. Treat those numbers as dated observations, not guaranteed plan limits.
Default to one Codex worker; use two only under the concurrency rule above. When Codex is quota-blocked, reroute rather
than repeatedly retrying.

**Claude usage (owner observation, 2026-09-28):** the Lead, local Claude workers, Claude Cloud sessions and claude.ai
chat draw from the owner's Claude plan limits. Keep the Lead lean: after an integrated increment, checkpoint and start a
fresh Lead session instead of carrying a needlessly long context. Use at most one Claude worker at a time; workers use
Sonnet by default, with Opus reserved for critical queue/write-core work.

**Claude Code Cloud:** use for substantial bounded repo-contained work when it is the best available budget/capability
fit. The detailed launch/push procedure above remains authoritative. Never send private vault content.

**ChatGPT review fallback:** while Codex is unavailable, the owner may relay a bounded review packet to ChatGPT for a
critical independent review. The account can inspect the GitHub repo, but the local Lead cannot invoke that chat
session or its local test environment directly, so the packet remains the handoff boundary. Use only for the same
critical cases that justify Astra-high, at most sparingly; public repo + synthetic data only, never private vault text.
The Lead writes `.agent/review-packet-<topic>.md` and emits an `ACTION NEEDED:` line with the exact relay instruction.

**Gemini CLI** (0.61.0): launch through the wrapper, never bare `gemini`:
`AGENT_USER_ENV=GEMINI_API_KEY bash tools/agent-pane.sh "gemini · <task>" <clone> <clone>/.agent/run.log bash tools/gemini-worker.sh <clone>`.
The wrapper reads `.agent/brief.md`, disables built-in sub-agents, runs headless in the disposable clone, and falls
back across its configured Flash-Lite/Flash models. One retry on transient 503/429 is enough; on quota failure reroute.
Use only for bounded low-risk public-repo work (UI/CSS, straightforward TypeScript, tests, docs, mechanical refactors,
simple bugs). Keep briefs idempotent because a model fallback can restart the brief against a partly edited clone.

**Antigravity:** free-tier fallback for bounded low-risk public-repo tasks. The stdin-prompt path has previously opened
with an empty prompt, so invoke it with the explicit instruction to read `.agent/brief.md`. Expect quota refusals and
reroute instead of waiting. Review its diffs like any other worker.

**Local Qwen:** tiny deterministic work only, one at a time, and only with at least 5 GB free RAM. It is a budget
fallback, not a reviewer for high-risk invariants.

**DeepSeek:** planned once the owner has credits and a verified wrapper. Do not route production work to it until the
harness, spending cap and one small trial are verified.

**Jev** (TypeSafe System One): a free typed judgment helper, never a worker or Lead. It may do first-cut triage on
public-repo material; high-risk decisions still get the Lead's own read. Product use with private note text requires a
separate privacy ADR.

**Shell hygiene (Lead):** never put Markdown with backticks or `$(…)` inside `node -e "…"`/`bash -c "…"` strings;
the shell can execute them. Write such text with file tools instead.

**RAM:** close finished Agents panes and stray preview servers; one Playwright job at a time; run e2e on a free
`PW_PREVIEW_PORT`.

## Worker → Lead handoff (owner, 2026-09-25)

Every implementation worker (Cloud, Astra, Qwen) commits a short branch-local `.agent/handoffs/<brief-name>.md` with:
1. **Completed** — what actually changed. 2. **Important discoveries** — unexpected technical/product/security
findings, including outside the brief. 3. **Recommend** — fix now / follow-up / leave alone. 4. **Verification** —
checks actually run and result. 5. **Commit** — SHA if available. Concise; not a review report. Launch prompts say so.

Before merging, the Lead reads it and dispositions **every** meaningful discovery: fix now, concrete follow-up in
`docs/plan.md`, or rejected with a reason (recorded in the PR comment). Worker-process commentary never goes into code
comments. The handoff file is deleted from the branch once integrated (or on `main` after merge).

## Pull requests and CodeRabbit (owner, 2026-09-25; clarified 2026-09-28)

All integrated changes go through a PR. Workers never merge. The Lead owns the final diff, verification and merge.

- **CodeRabbit is useful but not a merge gate.** After the PR's final pushes, request one
  `@coderabbitai full review` if no real review already exists. If it is skipped, rate-limited or unavailable, record
  that fact and continue when CI/local verification and the Lead's review pass. High-risk work still needs the
  independent review required by the routing table.
- Route actionable CodeRabbit findings through the **current routing table**, not a hard-coded provider/model. Fix with
  a regression test where appropriate or reject with a recorded reason.
- CodeRabbit has recently allowed roughly one full review per hour. Batch small follow-ups, bugs and docs into one PR
  per round; keep a new write target or security surface in its own PR. Never poll a rate-limited review.
- **Waking the Lead:** before stopping with delegated work outstanding, run `bash tools/wait-for-work.sh` in the
  background. It exits on a finished CodeRabbit review or a new `agent/*` branch on origin.
- Run `gh pr merge` from the main checkout; running it from a temporary worktree can merge remotely and then fail the
  local main checkout because `main` is already used by another worktree. CodeRabbit config: `.coderabbit.yaml`.
- **Codex runs in disposable full clones** under `C:\Dev\vault-companion-clones\<task>`, not git worktrees.
  `--sandbox workspace-write` can edit repository files but keeps `.git` read-only and has no GitHub credentials.
  Therefore Codex does **not** commit or push: the Lead reviews the diff, commits it, pushes the branch and opens/updates
  the PR. Other worker types may commit/push only when their documented backend procedure permits it.
- Workers must not edit `docs/plan.md`.
- Visibility: `pwsh -NoProfile -File tools/status.ps1` in its own pane shows agents, Codex logs, cloud session links,
  worker branches and open PRs.

