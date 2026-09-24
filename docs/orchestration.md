# Orchestration and model routing

Durable policy for multi-agent work on this repository (owner instruction, 2026-09-24).
Full background: bootstrap §5–7 in `docs/bootstrap/`.

## Roles

- **Lead: Claude Opus 5.5** (`claude-opus-5-5`). Owns architecture, decomposition, task contracts,
  integration, conflict reconciliation and final technical decisions. Never delegated.
- Workers and reviewers run in Herdr panes with bounded briefs (`docs/briefs/`), separate worktrees under
  `C:\Dev\vault-companion-worktrees\` for implementation, and report via files in `docs/reviews/`.
- ~2–3 concurrent workers at most. No recursive spawning unless the Lead explicitly delegates it.
- An implementation agent never certifies its own high-risk milestone.

## Model routing

| Use | Agent kind | Model |
|---|---|---|
| Lead; default implementation workers, specialists, fresh-context reviewers | `claude` | `claude-opus-5-5` |
| Independent **cross-model** architecture review; adversarial review of risky diffs; Markdown/data-integrity review; sync/concurrency review; security/privacy review; hard bounded bugs needing a second model family; critical QA before live-vault writes | `codex` | **GPT-6 Astra** `gpt-6-astra` |
| Routine bounded implementation; CI/CD and DevOps; test implementation; tooling; mechanical refactors; focused debugging not justifying Astra | `codex` | **GPT-6 Sol** `gpt-6-sol` |

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
