# Orchestration — how work gets delivered

Owner decision 2026-10-01 (ADR-0035). This file is **policy only**: no live state, PR heads, timestamps or quota
readings (those go in `docs/checkpoint.md`). Change it only on an owner decision, by editing it in place — never by
appending amendments. History: Git and branch `archive/codex-lead-2026-10-01`.

**What lives where (keep these in step; nothing else holds operating rules):**

| Place | Holds |
|---|---|
| this file | roles, workers, delivery loop, review, budget, authority defaults |
| `.agent/owner-instructions.md` (local, gitignored) | the owner's standing decisions; **overrides this file** where they differ |
| `tools/lead-prompt.md` | the Lead's start prompt (used by `start-lead.ps1` and the watcher) |
| `.claude/settings.json` (+ local) | pre-approved commands for the Lead |
| user `~/.claude/settings.json` → `autoMode.allow` | owner-approved auto-mode exceptions: sandboxed worker launches, production deploys |
| `docs/checkpoint.md` | current state only |

## Roles

- **Lead: Claude Sonnet 5.5, effort medium** (`tools/start-lead.ps1`; `-Overnight` = auto mode, no prompts, after
  `tools/preflight.ps1` passes). An engineer, not a dispatcher: owns understanding the relevant code,
  slicing, briefs, integration, acceptance, PRs and merges. **Delegates implementation by default** (Claude usage
  is the scarcest budget); writes code itself only for fixes of about 20 lines or after a worker failed twice.
  The overnight queue is backend, tooling and docs slices; screens follow **Screens** below.
- **Workers:** implement one bounded slice each in a disposable full clone under `C:\Dev\vault-companion-clones\`.
  They never merge, push to `main`, deploy, read the live vault or edit `docs/plan.md` / `docs/checkpoint.md`.
- **Owner:** product priorities (vault *Ready Backlog*, read-only for the Lead), deploys, phone acceptance.

## Sources of truth

| What | Where |
|---|---|
| Product priority | vault `Projects/Vault Companion/Vault Companion - Ready Backlog.md` (read-only, ADR-0018) |
| Current state, next action | `docs/checkpoint.md` — the **only** state file, ≤ 40 lines, overwritten at milestones |
| Engineering rules | `AGENTS.md` + the contract a task touches (`vault-contract`, `commands`, ADRs) |
| Policy | this file |

## Worker pool (cheapest capable first)

| Worker | Use for | Cost |
|---|---|---|
| **Gemini CLI** (Flash-Lite) | tiny, idempotent: docs, copy, rename, one-file tweak | free tier |
| **OpenCode on Scaleway** (`scw`, `-ScwModel`, default `qwen3.5-397b-a17b`) | **default** implementation while the voucher lasts (expires 31 Oct; tell the owner at EUR 20 left, stop at EUR 5) | ~EUR 0.02 per small task; Scaleway voucher |
| **DeepSeek V4.1 Flash** (`flash`, API id `deepseek-flash`), effort high | scw failed once, or the voucher is spent: UI, tests, bounded features, bug batches | cheap; owner's DeepSeek credit |
| **Codex gpt-6.1-sol** (`codex`, `-Effort low|medium`) | when needed: Flash failed once, or design-heavy UI / Morning Brief / data-integrity work | owner's Codex subscription (weekly limit) |
| **DeepSeek Pro**, effort **medium** | high-risk implementation only (see Review by risk) | ~4x Flash |

**Sub-workers:** Codex-driven workers (`flash`, `pro`, `codex`) may spawn up to 2 Codex sub-agents (one level deep,
same model, same sandbox) for clearly separable parts, e.g. tests beside the implementation. The brief says when
that is worth it; the worker stays responsible for one handoff. Scaleway's `deepseek-v4-flash-0731` is the older V4
Flash and, like GLM-5.2, has no Responses API (verified 2026-10-10), so it cannot drive Codex.

**`scw` sandbox (owner, 2026-10-10):** OpenCode has no OS sandbox, so its config
(`C:/Dev/tools/vault-companion-opencode/opencode-worker.json`) fences it: file tools inside the clone only, no web, shell
only pnpm check/test/lint/e2e/exec tsc|eslint|vitest|playwright and read-only git, no commits. Not watertight: a repo
test script still runs arbitrary code. With two parallel workers, prefer one `scw` and one other tier.

**Agent shells:** a `pwsh` or `opencode` started from Bash waits for stdin to close before it runs anything (verified
2026-10-11: a script's first line ran only when its stdin pipe closed). End such calls with `< /dev/null` and bound
one-shot calls with `timeout <s>`.

**Scaleway GLM-5.2 is not an implementation worker (2026-10-02):** Codex CLI needs the Responses API, which Scaleway
does not serve for GLM-5.2 (chat completions only), and OpenCode exited silently twice. Use GLM only for one-shot
public-repo questions over the plain API, not for edits: it is the **second code reviewer** (`tools/glm-review.ps1`, run by `handoff-check.ps1`; benchmark 2026-10-02: at reasoning `low` it found the same major missing-test issue as CodeRabbit in ~30 s / ~9k tokens; it tends to overrate severity).

Launch every worker with **one command**, from inside Herdr (it opens a visible pane in the Agents tab):

```sh
pwsh -NoProfile -File tools/launch-worker.ps1 -Tier scw [-ScwModel <m>]|flash|codex [-Effort low|medium]|pro|gemini|glm -Files a,b -Clone <clone> -Task <task> -Kind ui|backend|tooling|docs -Base <base> -TestCmd '<touched tests>' [-Reviewer both] [-Intent on|off]
```

DeepSeek workers run **sandboxed** (Codex `workspace-write` + elevated Windows sandbox, set up by the owner
2026-10-02): they edit and run tests inside their clone only; writes elsewhere are denied and their commands have no
network (the launcher runs `pnpm install` first). Never launch workers with `--dangerously-bypass-approvals-and-sandbox`:
it is unsafe and Claude Code's auto mode blocks it. Keys are read at run time, never printed.
Verify the model in the log header and real activity, then **end your turn** ("WAITING: <task>"): the watcher wakes
you with `WORKER-READY: <task> … <verdict>` when the worker and its pre-handoff review are done (or `WORKER-STUCK`).
Do not poll. The registry is `.agent/workers/<task>.json` (state running, checking, fixing, ready).

## Delivery loop (every slice)

1. **Slice small:** one observable outcome, aim ≤ 400 changed lines. A bigger feature is several slices/PRs.
2. **Clone + base:** `git clone` into a fresh clone, record the base commit, `pnpm install` there before launch.
3. **Brief ≤ 40 lines** in `<clone>/.agent/brief.md`: outcome, base commit, owned files (and permission to read
   their direct dependencies), the invariant at risk, acceptance checks, the exact touched-test command, stop rule,
   handoff path `.agent/handoffs/<task>.md` (≤ 15 lines).
4. **Worker runs once, then is reviewed before the handover** (automatic with `-Base`, owner 2026-10-10): the worker's
   pane runs `tools/worker-after.ps1` → `tools/handoff-check.ps1` — before the Lead reads any diff. It commits the candidate (never `.agent/`), runs the tests, reviews the complete delta (`-Reviewer auto`: CodeRabbit CLI while it has hourly reviews, else GLM-5.2; `both` for high-risk)
   and triages each finding with Jev. Exit 0 clean · 10 fixes needed · 20 tests failed · 30 review unavailable ·
   40 boundary refused.
5. **At most one correction round**, started automatically on exit 10 by the same worker session (`-Fix`), then the
   check once more; only then does the Lead get `WORKER-READY`. Still failing ⇒ the Lead fixes it itself or re-slices.
   Never a third worker round. (Manual: `tools/handoff-check.ps1 -Clone <clone> -Base <base> -Task <task> -TestCmd '…'`.)
6. **Lead acceptance:** read the diff (not the logs), run `pnpm check` + e2e **once** on the final candidate, push the
   branch, open the PR, merge when CI is green. One PR per slice; small fixes/docs batch into one PR per round.

## Screens (owner 2026-10-11)

A slice that changes what a screen shows (`-Kind ui`) is checked by looking at it. Text-only builds and checks let
screen bugs through: GAM1-B, built overnight from text, needed a full redo, and a sheet header hid content for weeks
while every e2e test passed. CodeRabbit and GLM read code only and cannot catch this.

- **Where:** in a daytime session with a model that can see images (the owner uses Opus 5.5 for these), working from
  the chosen mockup and screenshots. The overnight Lead builds a screen slice only when the owner asks, then follows
  the rest of this section.
- **Opus at two moments, not as Lead.** The Lead stays Sonnet: most Lead cost is rereading context all night, and a
  pricier Lead would not close the gap, which is seeing. For a screen slice the Lead spawns an Opus 5.5 subagent
  (Agent tool, `model: opus`) twice, each a single bounded task given file paths, not the conversation:
  1. **Brief:** from the mockup image the Ready Backlog item names, write the brief's Outcome, Acceptance and Quality bar
     and list the screen states to photograph.
  2. **Screenshot review before the PR:** compare the candidate's tour screenshots with the mockup; return
     match / mismatch per state with the concrete differences. A mismatch goes into the single correction round.
- **The screenshot check is part of done.** The slice adds its screens to `pnpm tour` (sheets at rest and scrolled;
  light and dark where colours change); the PR carries the 390x844 shots, about four images. Copy them out of
  `apps/web/test-results/` before a full e2e run, which clears that folder.
- **Shared parts get geometry tests** (AGENTS.md rule 9): one test on a shared part guards every screen using it.

## Review by risk

- **Ordinary** (UI, read-only views, tests, docs): handoff-check + Lead diff read + CI. PR-level CodeRabbit is
  optional and **never a merge gate**.
- **High-risk** — new vault write target, write/CAS/dedupe/receipt path, auth/Access, privacy boundary,
  concurrency/queue: add **one** independent review of the risky diff only. If a worker wrote it, the Lead's own
  focused review is that review (different model family). If the Lead wrote it, one DeepSeek Pro medium review with
  a packet of the risky diff + the invariant. Plus negative tests that fail when the guard breaks. Run its pre-handoff check with
  `-Reviewer both` (CodeRabbit + GLM second opinion).
- **Findings are fixed once and verified by the Lead.** A fix does not trigger a new full review unless it rewrites
  the risky logic. No review chains, no "floor" that blocks delivery when a provider is out of credit: reroute.

## Jev (cheap typed judgments, use by default)

Jev (`Tools/jev.ps1` in the vault, pinned `jev-1.13.0`, ~400 tokens a call) replaces Lead reasoning wherever the
question is a typed choice/score/yes-no over **public repo** material. Owner wants it used a lot:
- **Automatic:** review-finding triage inside `handoff-check.ps1`, for CodeRabbit and GLM alike (critical/major always fix; Jev decides the rest).
- **Before every dispatch (required):** choose the worker tier; state the brief's outcome, size and risk in a few
  lines. Follow Jev's pick unless the deterministic floor says otherwise (high-risk ⇒ Pro or Lead review), and say
  which in the STATUS line:
  `timeout 60 pwsh -NoProfile -File "$USERPROFILE/Obsidian Vault/Second Brain/Tools/jev.ps1" -State "<facts>" -Choose gemini,scw,flash,sol-medium,unresolved -Instructions "Cheapest worker that will likely pass the acceptance checks? gemini = tiny docs/copy, scw = default implementation, flash = scw already failed once, sol-medium = Flash already failed once or design-heavy UI / Morning Brief / data integrity" -Json < /dev/null`
- **Instead of deliberating:** "is this in scope?", "is this handoff claim supported by the test output?", "real
  failure or flaky?", "which backlog item is smallest?" — ask Jev (`-Ask` / `-Choose` / `-Rate`) first.
- **Test tier (advisory):** `tools/select-tests.ps1 -Paths <paths> [-HighRisk] [-NoJev]` prints `{tier, reason, source}`; the floor decides first.
  Worker/contracts/vault-markdown/auth/lockfile => full-e2e; docs-only => none; `-HighRisk` => full-e2e; only an open floor asks one Jev `-Choose`, any failure => full-e2e.
  `handoff-check.ps1` reports that tier and asks Jev one bounded `-Ask` per acceptance bullet (doubts under "Unverified") — advisory only, never changes the exit code.
Never send private vault text or raw logs to Jev. Receipts land in `.agent/jev-receipts.jsonl`; the Lead notes
notable misses in the checkpoint. Jev never accepts work, waives a check or authorizes anything.

## Budget and stop rules

- **One implementation worker at a time** (a free Gemini task may run beside it). One browser/e2e job at a time.
- A worker run above ~300k tokens, or two failed attempts on one slice ⇒ stop, re-slice or Lead takes over.
- Quota/credit/tooling failure ⇒ reroute to another approved worker or record a blocker. Never raise effort for it.
- DeepSeek: prefer off-peak (peak 03–06 and 08–12 Copenhagen, Mon–Fri). The Lead may read the balance endpoint
  without printing the key. Never buy credits, enable billing, or pass `--use-credits` to CodeRabbit.

## Lead token discipline

- Startup reads: `AGENTS.md` (auto), `docs/checkpoint.md`, the Ready Backlog's ranked table. Nothing else until a task
  needs it; then `rg -n` + a line window, not whole files.
- **Checkpoint inside the slice's PR:** update `docs/checkpoint.md` in the same PR before merging it. No
  checkpoint-only PRs (14 of 31 merged PRs on 2026-10-01/02 were just checkpoints, each a full PR/CI/merge cycle). A
  separate docs commit only for a pause or end of session with no open slice.
- **Fresh context after each merge:** create `.agent/restart-now`, then end the turn with a line containing only `LEAD-RESTART-NOW`;
  `tools/lead-watch.ps1` (second pane) sends `/clear` and the start prompt. Do the same before any wait longer than
  ~30 minutes. Usage limits need nothing: Claude Code continues by itself when the limit resets.
- Do not build orchestration tooling unless the owner asks for it. The tools here are enough.

## Authority

The Lead may push branches, open/close PRs and merge them. **Deploys, live/reference vault writes, credential,
Access and billing changes need the owner's explicit approval**, either standing (in `.agent/owner-instructions.md`)
or asked for with a line starting `ACTION NEEDED:` and the exact command. Live vault writes, credentials, Access and
billing are never standing approvals.

## Owner instructions

`.agent/owner-instructions.md` is where the owner's decisions survive context resets. The Lead reads it at every start
and **appends any decision the owner makes in chat** (dated, one line, before acting on it): approvals, priorities,
limits, "do X from now on". It is local and gitignored (it may name budgets and private preferences). The owner can
edit or delete lines at any time; a deleted line is no longer authority.

## Owner updates

The owner wants to follow progress without reading logs. Run `pwsh -NoProfile -File tools/owner-status.ps1` (one
line: free RAM, DeepSeek balance, Scaleway GLM estimate) and post a short update **in the Lead pane**:

- **When:** after each worker run and handoff-check, after each merge, when blocked, and before a long wait.
  Format: `STATUS: <what just happened> · <what's next> · <owner-status line>` — two lines at most.
- **Low RAM:** before launching a worker, `pnpm install` or e2e, run the script; exit 1 (< 3 GB free) ⇒ post
  `ACTION NEEDED: free RAM — <x> GB free, need ~3 GB for <job>` and wait instead of launching.
- **Credits:** after every paid DeepSeek run, include the balance; below $2 ⇒ `ACTION NEEDED:` with the remaining
  planned work, and switch to Gemini where the risk allows. After a GLM run, append `{"tokens":N}` (from its
  log) to `.agent/budget/scaleway.jsonl` (bookkeeping only). The Scaleway voucher limit is in EUR (owner instructions: tell the owner at EUR 20 left, stop at EUR 5), not tokens.
- **CodeRabbit:** at 0 reviews left in the hour, `handoff-check.ps1 -Reviewer auto` switches to GLM-5.2; say so in the STATUS line.
- **Rework (owner 2026-10-11):** every launch carries `-Kind`. On Sundays, and when the owner asks, run
  `pwsh -NoProfile -File tools/rework-report.ps1` and post its first line plus the worst tier or kind as a STATUS line.
  When the owner sends a merged slice back after review, record it the same turn:
  `tools/rework-report.ps1 -Reopen <task> -Reason "<one line>"`. Use the numbers to change tiers or brief style,
  not to argue about one slice.
- Lines starting `ACTION NEEDED:` are the only ones that require the owner to act; everything else is information.

## Herdr

Start the Lead inside Herdr with `pwsh -NoProfile -File tools/start-lead.ps1` (optional `-Focus "<task>"`; with
`-Overnight` it first runs `tools/preflight.ps1`: Herdr, CLIs, one bounded Jev call, Codex login, the elevated
sandbox for both Codex homes, DeepSeek balance and Scaleway models, ~2 minutes, no model tokens; a FAIL stops the
start while the owner is still awake, `-SkipPreflight` overrides), then
`pwsh -NoProfile -File tools/lead-watch.ps1` in a second pane; workers appear in the **Agents** tab via `tools/agent-pane.sh`. Never navigate
or close panes the Lead did not create. Never end a Claude agent with `/exit`; close its pane instead.
Git Bash rewrites `/word` arguments: prefix slash commands with `MSYS_NO_PATHCONV=1`.
