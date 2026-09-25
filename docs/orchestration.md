# Orchestration and model routing

Durable policy for multi-agent work on this repository (owner instruction, 2026-09-24).
Full background: bootstrap §5–7 in `docs/bootstrap/`.

## Roles

- **Lead: Claude Opus 5.5** (`claude-opus-5-5`). Owns architecture, decomposition, task contracts,
  integration, conflict reconciliation and final technical decisions. Never delegated.
- Workers and reviewers run in Herdr panes with bounded briefs (`docs/briefs/`), separate worktrees under
  `C:\Dev\vault-companion-worktrees\` for implementation, and report via files in `docs/reviews/`.
- Concurrency: no fixed cap (owner, 2026-09-25) — spin up as many workers as genuinely independent work allows; the
  practical limit on this machine is memory (~2 GB free observed; two background waiters were reaped). No recursive
  spawning unless the Lead explicitly delegates it.
- An implementation agent never certifies its own high-risk milestone.

## Model routing

| Use | Agent kind | Model |
|---|---|---|
| Lead; default implementation workers, specialists, fresh-context reviewers | `claude` | `claude-opus-5-5` |
| Independent **cross-model** architecture review; adversarial review of risky diffs; Markdown/data-integrity review; sync/concurrency review; security/privacy review; hard bounded bugs needing a second model family; critical QA before live-vault writes | `codex` | **GPT-6 Astra** `gpt-6-astra` |
| Routine bounded implementation; CI/CD and DevOps; test implementation; tooling; mechanical refactors; focused debugging not justifying Astra | `codex` | **GPT-6 Sol** `gpt-6-sol` |

**Owner decision 2026-09-25:** GPT-6 Sol is not available on the owner's Codex (ChatGPT) account (`model is not supported`).
Sol-class work (the row above) therefore uses **GPT-6 Astra with reasoning effort `low` or `medium` — never higher**:
`codex exec -m gpt-6-astra -c model_reasoning_effort="medium" …` (verify `reasoning effort:` in the log header).
Astra reviews (the row before) keep their default effort.

Rules:
- Always pass the model explicitly; never rely on a CLI default:
  - `herdr agent start <name> --kind claude --pane <pane-id> -- --model claude-opus-5-5`
  - `herdr agent start <name> --kind codex --pane <pane-id> -- -m gpt-6-astra`
  - `herdr agent start <name> --kind codex --pane <pane-id> -- -m gpt-6-sol`
- Verify the active model after launch before assigning substantial work; report unavailability instead of
  silently substituting.
- Do not duplicate one implementation task across Claude and Codex except as a deliberate independent
  comparison or review.
- Introduce a Codex agent when a genuinely suitable task appears; never interrupt a milestone just to add one.

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

- Only for bounded, repo-contained tasks: no live vault, Windows-only tooling, Herdr state or local sync. Never send the
  personal vault repository to the cloud. Cloud workers count as workers for concurrency planning.
- Precondition: `git remote -v` shows a GitHub remote for this repo. If not, stop and tell the owner; never create one.
- Launch: commit + push the brief, then
  `claude --cloud "Read AGENTS.md, then follow docs/briefs/<brief>.md exactly. Work on branch agent/<name>. Run required tests, commit and push the branch when done. Do not open a PR or spawn agents."`
  Record session ID + branch in `docs/plan.md`. Continue a session: `claude -p "<message>" --cloud <session-id>`.
- Finish: `git fetch`, review the branch, run verification locally, merge if accepted.
- First use is one small task to verify the workflow. Verified 2026-09-25 (brief C).
- `claude --cloud` needs an interactive TTY: launch it with `herdr pane run <pane> "claude --cloud '…'"` and read the
  `Created cloud session: … session_<id>` line from the pane.
- **Routing under Claude-token pressure (owner, 2026-09-25):** most implementation goes to Claude Code Cloud; small or
  low-risk tasks to Codex GPT-6 Astra at effort `low` (`cmd /c "codex exec -m gpt-6-astra -c model_reasoning_effort=low …"`).
  The local Lead stays lean: decompose, review, integrate.

## Pull requests and CodeRabbit (owner, 2026-09-25)

The repo is public and CodeRabbit reviews pull requests (not direct pushes). Every finished worker branch is merged
through a PR opened by the Lead: open PR → wait for CodeRabbit → hand the CodeRabbit comments to a worker via
`docs/briefs/PR-coderabbit-loop.md` (Cloud, or Astra low for small PRs), which fixes with a test or rejects with a reason → verify locally (`pnpm check`, e2e where relevant) → merge. Workers never open PRs.
- **The Lead pushes and merges PRs itself** once CodeRabbit's comments are resolved and all checks/local verification pass (owner, 2026-09-25). If CodeRabbit has not reviewed a PR, comment `@coderabbitai review`.
- **Waking the Lead:** before stopping with delegated work outstanding, run `bash tools/wait-for-work.sh` as a
  background command. It exits on a finished CodeRabbit review or a new `agent/*` branch on origin, which re-invokes the Lead.
- Run `gh pr merge` from the main checkout: from a temporary worktree it merges remotely, then fails the local
  `main` checkout (`'main' is already used by worktree`).
Config: `.coderabbit.yaml`.
- Codex `--sandbox workspace-write` cannot write a git **worktree's** git dir (it lives in the main repo's `.git`), so
  Codex tasks run in a **full clone** under `C:\Devault-companion-clones\<task>` and push their own branch.
- Codex `workspace-write` keeps `.git` **read-only** and has no GitHub credentials (verified 2026-09-25): Astra edits
  files only; the Lead reviews the diff, commits, pushes and comments. Workers must not edit `docs/plan.md`.
- Visibility: `pwsh -NoProfile -File tools/status.ps1` in its own pane shows agents, Codex logs, cloud session links,
  worker branches and open PRs (refresh 30 s).
