# Orchestration and model routing

Durable policy for multi-agent work on this repository (owner instruction, 2026-09-24).
Full background: bootstrap §5–7 in `docs/bootstrap/`.

## Current precedence and decision layer (owner correction, 2026-10-01)

Jev is the default first decision layer for compatible cheap structured judgments, including eligible worker,
model and provider selection. It is System One beneath the Lead, not an implementation worker or a replacement
for the Lead. Deterministic code decides exact questions first. Generative/System-Two reasoning owns architecture,
implementation, ambiguous open-ended reasoning and difficult diff understanding. The operational Jev entry below
defines Use 1, Use 2, thresholds, invocation, privacy and measured-outcome safeguards.

Current queue, appointment, verified runtime and budgets are in plan/checkpoint; their current owner instructions
override dated continuous-mode/budget observations below. One active implementation feature; a second worker
only for independent review or bounded existing close-out. One browser job; no recursive delegation.
The Lead reads source when needed and owns integration, diagnosis, acceptance and release preparation.
Retain holds, actual CodeRabbit review (minimum 60 minutes between requests across the queue), current CI and
required independent review. A merge is separate from production deployment and authenticated phone acceptance;
each additional deployment requires scoped owner authority. No live/reference-vault writes or credential/billing changes.

## Historical continuous guidance (2026-09-30; current amendments take precedence)

These dated instructions are historical where they conflict with current owner instructions. Current Lead appointments and
temporary exceptions belong in `docs/plan.md`, not here.

- **Queue:** the Ready table in the vault's Ready Backlog, top to bottom in the owner's priority order, plus its
  bug backlog, with bugs batched. Check the definition of ready. If an item is not ready, record the questions
  under `Waiting for Evgeny` in `docs/plan.md` and take the next item. Never build from the Ideas Backlog.
- **Lead role:** planning, decomposition, delegation, integration and acceptance, not implementation. Delegate
  according to the routing table to Herdr workers through `tools/agent-pane.sh`.
- **Token economy:** read diffs, handoffs and gate verdicts rather than whole files.
- **Historical turn pacing (superseded by current owner recovery/overnight rules):** never wait or poll inside a Lead turn. End with
  `WAITING: <what>` and let the watcher resume the Lead with `WAKE: <event>`. Read worker handoffs, not logs; if a
  log is required for launch verification or diagnosis, read at most its last 20 lines. The Lead does not read
  source files while coordinating; use `git diff --stat` and delegate source inspection. Save Jev responses to
  files and expose only their answer fields to the Lead.
- **Acceptance:** evidence only. Use the harness gates once H exists; until then use the current handoff and
  check rules. A worker's completion claim is not acceptance.
- **Shipping:** PR → CodeRabbit → merge → deploy using the normal runbook. Never merge a PR with the `hold`
  label or an unanswered owner comment. Ask the owner before deploying anything that touches auth, identity,
  the write path or a new write target.
- **After each shipped item:** update the plan and checkpoint, commit, and print
  `SHIPPED: <item> — phone-test: <what to check>`.
- **Stuck work:** follow the escalation rule. When exhausted, park the item with a reason and continue.
- **Questions:** print `ACTION NEEDED:` lines and keep working on other items meanwhile.

## Roles

- **Lead:** current appointment and actual runtime are recorded in plan/checkpoint; Claude Opus was the historical default. Owns architecture, decomposition, task contracts,
  integration, conflict reconciliation and final technical decisions. Never delegated.
- Workers and reviewers run with bounded briefs. Claude/local workers normally use separate worktrees under
  `C:\Dev\vault-companion-worktrees\`; Codex uses disposable full clones under
  `C:\Dev\vault-companion-clones\` because its workspace sandbox cannot write a worktree's shared `.git`.
  Implementation workers hand off through `.agent/handoffs/`; dedicated reviewers write `docs/reviews/` when a durable review is required.
- Historical concurrency was budgeted, not unlimited: **one Codex worker by default** (maximum two only when the Lead recorded that
  the tasks are independent and the speedup is worth the quota), **one Claude worker at a time**, and **one Playwright
  job at a time**. Never run two Astra-high jobs in parallel. Free/local workers are additionally limited by RAM and
  provider quotas. No recursive spawning unless the Lead explicitly delegates it.
- An implementation agent never certifies its own high-risk milestone.

## Current model routing — single source of truth

This section is the **only active routing table**. Dated usage observations later in this document explain why the
policy exists; they do not override it. Model availability changes, so every launch still verifies the model and
reasoning effort from the worker banner/log.

Before a compatible routing decision, use Jev Use 2 with only currently eligible choices from this pool plus
`unresolved`. Verify availability, privacy, budget and deterministic risk floors before constructing the choices.
Do not infer availability from older model rows. Route to the cheapest capable eligible model; guarded free GLM
is preferred when suitable. A new or resumed Lead must invoke Jev, or record a concrete fallback reason.

| Task | Default worker/model |
|---|---|
| Supplementary one-step ordinary review | Jev selects among guarded Scaleway `glm-5.2`, DeepSeek Flash/Pro and economical Codex; GLM preferred when its current task guard/trial is usable |
| Ordinary implementation: bounded edits, UI, tests, bugs and moderate debugging | Jev selects among eligible DeepSeek `deepseek-flash` **high** and economical Codex workers; GLM only after an equivalent multi-step guard is verified |
| Implementation needing Sol-medium judgment or broader context | DeepSeek `deepseek-pro` **high** |
| Floor implementation and independent review: auth, write path, persistence, concurrency, security/privacy, CI, harness/hooks, new write targets | DeepSeek `deepseek-v4-pro` **high** under existing owner authorization; fresh independent reviewer, held PR, Lead acceptance; Jev cannot downgrade |
| Economical bounded Codex worker | Verified `gpt-6.1-sol` **low** (owner authorized); other rows only if currently available and authorized |
| Other economical Codex / free-local ordinary choices | Only currently available and explicitly authorized models; verify banner/effort and existing privacy/budget bounds before including |

**Historical owner update 3 (superseded where it conflicts with current owner instructions): the DeepSeek rows take precedence for implementation; older Codex rows remain
capability/review references. No B3 graduation gate. Up to three DeepSeek workers on independent files, one
Playwright job. Temporary Codex budget mode in plan prohibits new OpenAI Codex workers.**
`deepseek-pro` is the routing tier; the verified API model ID passed to `-m` is `deepseek-v4-pro`.

Free/local workers (Gemini, Antigravity, Qwen) may replace Luna/Terra only for bounded low-risk public-repo work; their
operational constraints are below. The **current appointed Lead** keeps architecture, decomposition,
integration, conflict reconciliation and final acceptance.

### Escalation rule

1. Start at the lowest tier that should reasonably pass given the task's ambiguity and risk.
2. Give it one proper attempt. If verification exposes a clear implementation mistake, allow one focused correction
   at the same tier.
3. Escalate **one tier** only when the evidence shows the task needs more reasoning, broader context or stronger review.
4. Never escalate because of a rate limit, unavailable model, missing access, broken tooling, flaky test, dependency
   problem or under-specified brief. Fix/reroute the blocker instead.
5. Record the deterministic risk reason for floor work; retain the established Pro independent floor.
6. Do not duplicate implementation across models except for a deliberate independent comparison or review.

### Launch rules

Always pass the model and effort explicitly; never rely on CLI defaults. Examples:

```sh
codex exec -m gpt-6.1-sol -c model_reasoning_effort=low …
codex exec -m deepseek-v4-pro -c model_provider=deepseek -c model_reasoning_effort=high …
```

All Codex repo workers also disable memories:
`-c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false`.

The Codex sandbox cannot reach the pnpm store: the Lead runs `pnpm install` in the clone **before** launching Codex.

Verify `model:` and `reasoning effort:` in the log before substantial work. If a model is unavailable, record that
fact and consciously reroute; never silently substitute. The header alone does not prove the run started: a run
launched while the quota is exhausted prints it and then fails at once ("usage limit … try again at"), so confirm real
activity (exec/thinking lines) in the log.

### Changing this policy

Routing is expected to change (e.g. when DeepSeek is added). To add, remove or re-tier a backend, edit only:
1. the routing table above (its row or the model it names);
2. its operational entry under *Budget observations and alternative backends* (wrapper, quota, privacy limits);
3. one line in `docs/decisions/0030-cost-aware-worker-model-routing.md` or a superseding ADR.

A new backend enters the table only after its wrapper, spending cap and one small trial are verified. Nothing else
names models: new briefs say "model per routing table", and the model lines in older dated briefs (`docs/briefs/`) are
historical, never instructions.

Make these policy changes through a focused branch/PR, independent review, current CI and actual CodeRabbit;
retain existing holds and floors. Synchronize plan/checkpoint pointers and evidence without duplicating routing
tables or secrets. The owner's Oct1 Jev correction authorizes this change, not any new deployment or privacy scope.

## Sources of truth and vault access (owner, 2026-09-26; ADR-0018)

- **Priority and product decisions:** the owner's vault note `Projects/Vault Companion/Vault Companion - Ready
  Backlog.md`. The Lead reads it (read-only) before choosing work and never edits it.
- **Engineering status:** `docs/plan.md`, written only by the Lead; it links to the Ready Backlog, not copies it.
- **Live vault reads:** the local Lead only, read-only, paths per ADR-0018. Workers of any kind (Cloud, Codex,
  Antigravity, Qwen, Jev) never touch the live vault; their briefs are synthetic, with shapes derived by the Lead.
  Historical broader DeepSeek access is not an instruction to put private text in worker/Jev packets. Current
  repository constitution and owner privacy boundaries apply: local Lead-only task-relevant read access;
  no private text in this repo, logs, screenshots or cloud judgment packets.

## Visible agents (owner, 2026-09-26)

Every non-interactive worker starts through `tools/agent-pane.sh` so the owner can watch it live:
one labelled pane per agent (`<model>-<effort> · <task>`) in the **Agents** tab (created on demand, never focused),
output streamed in the pane and tee'd to the log, pane closes itself 60 s after the command ends (the tab closes with
its last pane). Codex runs add `-c model_reasoning_summary=concise -c model_verbosity=low -c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false` so reasoning summaries are visible.

```sh
AGENT_STDIN=<clone>/.agent/brief.md bash tools/agent-pane.sh "<model>-<effort> · <task>" <clone> <clone>/.agent/run.log \
  codex exec -m <model from routing table> -c model_reasoning_effort=<effort> -c model_reasoning_summary=concise -c model_verbosity=low -c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false \
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
evidence. Review briefs are packets too: the diff plus only the relevant ADR/invariant, not the whole repository.

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
- Interactive Claude worker panes use the documented worktree flow; confirm the model from the startup banner before prompting. Codex uses the non-interactive full-clone flow below, not this worktree flow.
- Hand briefs/diffs over as files; reviewers reply with a one-line verdict and write details to a file.
- **Codex in Herdr (Windows, codex-cli 0.154):** interactive `codex` first shows a *"Do you trust the contents of
  this directory?"* dialog that Herdr reports as `idle` (not `blocked`); a prompt sent then answers the dialog and
  quits Codex. Do not trust directories on the owner's behalf. Run bounded Codex tasks non-interactively through the
  visible-agent wrapper, using the model + effort selected by the current routing table and a disposable full clone.
  Verify both `model:` and `reasoning effort:` in the log header. The owner may choose to trust the repo once to
  enable interactive agents.

## Resumability (owner requirement, 2026-09-24)

Progress must survive usage limits, Herdr restarts, compaction, sleep and reboot. Conversation context is never
the only record.

- `docs/plan.md` always states: active milestone, done, in progress, delegated agents (pane, branch, commit),
  unresolved issues, failed QA, and **exact next actions**.
- `docs/checkpoint.md` is overwritten (not appended) at stable points and before any long pause, compaction or
  usage-limit boundary: completed, remaining, risks, branches/worktrees, tests run + results, exact next action.
- Commit at every stable checkpoint; never accumulate a large uncommitted tree. Workers with git-write access commit before being idle or retired. Codex cannot write `.git`, so the Lead reconciles and commits its edited clone plus handoff before retirement. Remove a worktree/clone only after its state is merged or recorded as abandoned.
- Consequential decisions go into ADRs, not only into conversation.
- If usage is about to run out: stop at a safe point, commit, update plan + checkpoint, leave no half-applied edit.

### Resume procedure (any Lead, fresh context)

1. `git status`, `git log --oneline -15`, `git worktree list`, `git branch -vv`.
2. Read `docs/checkpoint.md`, then `docs/plan.md`, then only the ADRs/docs the next action names.
3. `herdr agent list` (inside Herdr) — reconcile with the plan's delegated-agents table; read a worker's report file
   before re-prompting it. Never re-dispatch work whose branch already contains it.
4. Reconcile current evidence with the source/configuration before relying on it; run changed/required checks,
   not unchanged passing suites as a ritual. Consume compatible completed handoffs with Jev Use 1 plus Lead verdict.
5. Before the next compatible routing/structured decision, use the Jev operational entry below (Use 2), or record
   the concrete fallback/exclusion. Deterministic floors and an active kill switch always take precedence.
   Verify the existing watcher targets this Lead and bind new results to the current task/candidate before waiting.
- `MSYS_NO_PATHCONV=1` also disables Git Bash path translation for git: pass Windows paths (`C:/Dev/...`) to git while
  it is set, or `/c/Dev/...` becomes `C:/c/Dev/...` (happened once; empty leftover dirs under `C:\c\` for the owner to delete).
- `codex exec` writes its transcript to **stderr**; under Windows PowerShell 5, `2>&1 | Tee-Object` renders every line
  red as a NativeCommandError even when the run is healthy (owner saw an all-red pane, 2026-09-25). Check the log for
  real `ERROR` lines instead of the colour. New runs use `tools/agent-pane.sh` (see Visible agents), which avoids this.

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

**ChatGPT review fallback — temporary, only while Codex is out (drop it when Codex quota returns):** the owner may
relay a bounded review packet to ChatGPT for a critical independent review. ChatGPT can read the public GitHub repo
(owner-confirmed 2026-09-28), so the packet names the branch/PR, commit and file paths instead of pasting code; the
local Lead cannot invoke that chat session or its test environment, so the packet remains the handoff boundary. Use only for the same
critical cases that justify Astra-high, at most sparingly; public repo + synthetic data only, never private vault text.
The Lead writes `.agent/review-packet-<topic>.md` and emits an `ACTION NEEDED:` line with the exact relay instruction.

**Gemini CLI** (0.61.0): launch through the wrapper, never bare `gemini`:
`AGENT_USER_ENV=GEMINI_API_KEY bash tools/agent-pane.sh "gemini · <task>" <clone> <clone>/.agent/run.log bash tools/gemini-worker.sh <clone>`.
The wrapper reads `.agent/brief.md`, disables built-in sub-agents, runs headless in the disposable clone, and falls
back across its configured Flash-Lite/Flash models. One retry on transient 503/429 is enough; on quota failure reroute.
Use only for bounded low-risk public-repo work (UI/CSS, straightforward TypeScript, tests, docs, mechanical refactors,
simple bugs). Keep briefs idempotent because a model fallback can restart the brief against a partly edited clone.

**Antigravity (agy 1.2.11):** free-tier fallback for bounded low-risk public-repo tasks. `-p -` with a stdin brief
sometimes starts with an empty prompt, so pass the prompt as text (still via `tools/agent-pane.sh`):
`agy.exe -p "Read the file .agent/brief.md in the current directory and carry out that task exactly as written." --model gemini-3.8-flash-medium --dangerously-skip-permissions`.
Expect quota refusals and reroute instead of waiting. Review its diffs like any other worker's (an early fix of its
removed an identity guard).

**Local Qwen:** tiny deterministic work only, one at a time, and only with at least 5 GB free RAM. It is a budget
fallback, not a reviewer for high-risk invariants.

**DeepSeek (historical owner update 3, 2026-09-30; current amendments take precedence):** default implementation backend, Flash by default and Pro for Sol-medium
judgment/floor work. Smoke and balance API verified; no B3 graduation gate. Current one-feature/review concurrency
and public/synthetic worker packets apply; older broader private access and three-worker rules are retired.
Default launcher remains
`tools/agent-pane.sh` with `AGENT_USER_ENV=DEEPSEEK_API_KEY`, an isolated no-MCP/no-memory DeepSeek `CODEX_HOME`,
explicit model/provider/effort and `--sandbox workspace-write`. Claude-on-DeepSeek (`Tools/claude-deepseek.ps1`)
is allowed without WSL/container if needed. Never print keys. Read `GET https://api.deepseek.com/user/balance`
using the Windows User key before/after dispatch and meaningful checkpoints. The owner removed the $3 reserve:
use the actual available balance economically until exhausted/provider refusal, never infer a top-up or buy credits.
Every diff needs Lead review and `verify-run` once available; floor PRs retain `hold` and fresh independent Pro
review under existing owner authorization. Private text never enters repo/logs/receipts; Jev's
public-only boundary remains. One Playwright job at a time.

**Scaleway GLM-5.2 (owner authorized, Oct1):** configured OpenCode smoke passed. Use
`opencode run --standalone --model scaleway/glm-5.2` or a bounded direct API invocation with existing authentication;
no credential duplication or billing changes. Initial task is one-step ordinary review, no tools/delegation/network
access by the model, small public/synthetic packet, maximum output 2048. Before dispatch reserve 50000 tokens;
observed usage plus reservation must remain <=900000 of the owner's declared 1000000 free allocation (100000
safety margin). Check actual usage before/after: OpenCode Scaleway stats plus direct-API response usage ledger;
count input/output/reasoning/cache conservatively without double counting. Local stats are not account-wide balance
proof: missing usage, outside-usage uncertainty or insufficient free allowance stops new dispatch. No paid fallback.
Multi-step implementation requires an equivalently bounded verified guard first. GLM does not replace the Pro floor.

**Jev — active default System One (Use 1 / Use 2):** prefer deterministic code for exact decisions. Otherwise use
typed Choice/Score/Noul judgments for compatible cheap triage, classification, relevance/filtering, tool choices,
review necessity and routing. Batch related questions in one call when practical. Do not force architecture,
ambiguous design, implementation or difficult diff analysis into a typed question to avoid generative reasoning.

- **Use 2, before compatible routing:** filter the current pool by availability, budget, privacy and task risk.
  Include guarded Scaleway GLM-5.2, DeepSeek Flash/Pro and currently eligible economical Codex workers when
  allowed, plus `unresolved`. Ask tier/provider choice, integrity class and ambiguity together. Follow a low-risk
  choice only when its top probability is >=0.60, integrity class is ordinary and ambiguity probability is <0.50.
  Otherwise the Lead applies normal routing and records the fallback reason. Never treat headline confidence as
  the top-choice probability. Missing/malformed answers, unavailable helper/provider or an unresolved choice
  also require explicit fallback, without repeated unchanged failed calls or fabricated Jev use.
- **Deterministic floor overrides every Jev result:** security/privacy/auth/identity/account binding, writes,
  persistence/concurrency/data integrity, new write targets and harness/hooks/CI keep their established floor.
  Exclude ineligible lower choices before the call; log any conflicting advice and retain the floor. Jev cannot
  remove a hold, waive a review/check, authorize live access/writes/deployment or certify a worker's implementation.
- **Use 1, after every compatible completed worker:** batch completion, verification sufficiency, scope adherence
  or creep, silent-failure risk, unsupported claims, and redo/escalation/review disposition. Supply filtered facts
  and material limitations, not an unexamined success claim. Record Jev advice next to the Lead verdict; the Lead
  reads the source/evidence and owns acceptance. Uncertain scores prompt inspection rather than prove a defect.
  If a run cannot safely be summarized within the public boundary, record that exclusion/fallback explicitly.
- **Privacy and invocation:** only the local Lead calls the existing authorized helper. Resolve
  `Join-Path $env:USERPROFILE 'Obsidian Vault/Second Brain/Tools/jev.ps1'`; check `Test-Path`, then use
  `& $jev -StateFile <filtered-public-packet> -QuestionsFile <typed-questions.json> -Json`.
  `-Ask`, `-Choose` and `-Rate` cover single judgments; `-QuestionsFile` batches named questions with
  `type: choice` plus criteria including unresolved, `type: score` plus ordered criteria, or `type: boolean`
  (helper converts boolean to direct-API Noul). The helper defaults to pinned `jev-1.13.0`; direct credentials are
  resolved from existing TYPESAFE_API_KEY, with configured gateway fallback. Do not copy the key/helper into the
  repository, print credentials, or pass raw worker logs/private vault text. If the helper is absent, record its
  missing path and use normal Lead policy; do not search unrelated private notes or create another invocation.
  Product use with private note text requires a separate privacy ADR.
- **Receipts and calibration:** save packets, question objects and responses in gitignored `.agent/jev/` and an
  outcome ledger bound to task ID, candidate SHA/diff, timestamp and model. Record eligible choices/floors,
  probabilities, followed/overruled/fallback reason, Lead verdict and actual subsequent checks/redo/escalation.
  Ensure local Git exclusion before writing; never commit these receipts or an API key. At meaningful checkpoints
  report followed/overruled picks and affected runs; unknown remains unknown. Preserve prior observations rather
  than resetting the experiment on resume. **Existing kill switch:** two of the first five Jev-picked runs needing
  escalation/redo disables active routing, reverts Use 2 to shadow and requires an owner report. Continue Use 1
  and deterministic floors. Later demonstrably poor routing likewise warrants an explicit stop/reassessment,
  never a silent threshold change. Threshold/routing changes use the policy-change contract above.

**Shell hygiene (Lead):** never put Markdown with backticks or `$(…)` inside `node -e "…"`/`bash -c "…"` strings;
the shell can execute them. Write such text with file tools instead.

**RAM:** close finished Agents panes and stray preview servers; one Playwright job at a time; run e2e on a free
`PW_PREVIEW_PORT`.

## Worker → Lead handoff (owner, 2026-09-25)

Every implementation worker writes a short `.agent/handoffs/<brief-name>.md` in its workspace with:
1. **Completed** — what actually changed. 2. **Important discoveries** — unexpected technical/product/security
findings, including outside the brief. 3. **Recommend** — fix now / follow-up / leave alone. 4. **Verification** —
checks actually run and result. 5. **Commit** — SHA if the backend can commit. Concise; not a review report. Backends
with git-write access commit the handoff; Codex leaves it for the Lead to review and commit with the diff.

Before merging, the Lead reads it and dispositions **every** meaningful discovery: fix now, concrete follow-up in
`docs/plan.md`, or rejected with a reason (recorded in the PR comment). Worker-process commentary never goes into code
comments. The handoff file is deleted from the branch once integrated (or on `main` after merge).

## Pull requests and CodeRabbit (owner, 2026-09-25; clarified 2026-09-28)

All integrated changes go through a PR. Workers never merge. The Lead owns the final diff, verification and merge.

- **Actual CodeRabbit review is required.** On a stable locally verified candidate, request
  `@coderabbitai full review`, retaining the minimum 60-minute interval across the queue. Read the actual review
  and disposition all findings; SUCCESS metadata, a skipped/rate-limited/unavailable review or an older candidate
  does not satisfy the gate. Retain hold and advance another authorized independent item during external wait.
  Current CI and the independent review required by the routing table remain separate gates.
- Route actionable CodeRabbit findings through the **current routing table**, not a hard-coded provider/model. Fix with
  a regression test where appropriate or reject with a recorded reason.
- CodeRabbit has recently allowed roughly one full review per hour. Batch small follow-ups, bugs and docs into one PR
  per round; keep a new write target or security surface in its own PR. Never poll a rate-limited review.
- **Waking the Lead:** before waiting, verify the existing watcher named by the checkpoint targets this Lead,
  retains failed deliveries and observes current-task results/PRs. Verify actual resumed activity, not just prompt
  submission. Do not start a duplicate watcher or treat an old handoff as current completion.
- Run `gh pr merge` from the main checkout; running it from a temporary worktree can merge remotely and then fail the
  local main checkout because `main` is already used by another worktree. CodeRabbit config: `.coderabbit.yaml`.
- **Codex runs in disposable full clones** under `C:\Dev\vault-companion-clones\<task>`, not git worktrees.
  `--sandbox workspace-write` can edit repository files but keeps `.git` read-only and has no GitHub credentials.
  Therefore Codex does **not** commit or push: the Lead reviews the diff, commits it, pushes the branch and opens/updates
  the PR. Other worker types may commit/push only when their documented backend procedure permits it.
- Workers must not edit `docs/plan.md`.
- Visibility: `pwsh -NoProfile -File tools/status.ps1` in its own pane shows agents, Codex logs, cloud session links,
  worker branches and open PRs.
