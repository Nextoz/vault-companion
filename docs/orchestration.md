# Orchestration — how work gets delivered

Owner decision 2026-10-01 (ADR-0035). This file is **policy only**: no live state, PR heads, timestamps or quota
readings (those go in `docs/checkpoint.md`). Change it only on an owner decision, by editing it in place — never by
appending amendments. History: Git and branch `archive/codex-lead-2026-10-01`.

## Roles

- **Lead: Claude Opus 5.5, effort medium.** An engineer, not a dispatcher: owns understanding the relevant code,
  slicing, briefs, integration, acceptance, PRs and merges. Makes small fixes itself when delegating costs more.
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
| **Scaleway GLM-5.2** (OpenCode) | ordinary bounded implementation — **trial**: first tasks small, compare with Flash | free allocation (~1M tokens) |
| **DeepSeek Flash**, effort high | **default** ordinary implementation: UI, tests, bounded features, bug batches | cheap; half price off-peak |
| **DeepSeek Pro**, effort **medium** | high-risk implementation only (see Review by risk) | ~4× Flash |

Launch every worker visibly from inside Herdr; keys are read at run time, never printed:

```sh
# DeepSeek (Flash shown; Pro: -m deepseek-v4-pro -c model_reasoning_effort=medium)
AGENT_STDIN=<clone>/.agent/brief.md AGENT_USER_ENV=DEEPSEEK_API_KEY bash tools/agent-pane.sh "flash · <task>" <clone> <clone>/.agent/run.log \
  env CODEX_HOME=C:/Dev/tools/vault-companion-deepseek-home codex exec -m deepseek-flash -c model_provider=deepseek \
  -c model_reasoning_effort=high -c model_reasoning_summary=concise -c model_verbosity=low -c features.memories=false \
  -c memories.use_memories=false -c memories.generate_memories=false --dangerously-bypass-approvals-and-sandbox -C <clone> -
# Scaleway GLM-5.2
AGENT_USER_ENV=SCW_SECRET_KEY bash tools/agent-pane.sh "glm · <task>" <clone> <clone>/.agent/run.log \
  opencode run --standalone --model scaleway/glm-5.2 "Read .agent/brief.md and carry out that task exactly as written."
# Gemini
AGENT_USER_ENV=GEMINI_API_KEY bash tools/agent-pane.sh "gemini · <task>" <clone> <clone>/.agent/run.log bash tools/gemini-worker.sh <clone>
```

Verify the model in the log header and real activity before waiting. Wait on the log's last line, not by polling.

## Delivery loop (every slice)

1. **Slice small:** one observable outcome, aim ≤ 400 changed lines. A bigger feature is several slices/PRs.
2. **Clone + base:** `git clone` into a fresh clone, record the base commit, `pnpm install` there before launch.
3. **Brief ≤ 40 lines** in `<clone>/.agent/brief.md`: outcome, base commit, owned files (and permission to read
   their direct dependencies), the invariant at risk, acceptance checks, the exact touched-test command, stop rule,
   handoff path `.agent/handoffs/<task>.md` (≤ 15 lines).
4. **Worker runs once.** Then the Lead runs the pre-handoff check — before reading any diff:
   `pwsh -NoProfile -File tools/handoff-check.ps1 -Clone <clone> -Base <base> -Task <task> -TestCmd '<touched tests>'`
   It commits the candidate (never `.agent/`), runs the tests, reviews the complete delta with the CodeRabbit CLI
   and triages each finding with Jev. Exit 0 clean · 10 fixes needed · 20 tests failed · 30 review unavailable ·
   40 boundary refused.
5. **At most one correction round**, by the same worker session (`codex exec resume …` with `.agent/fix-<task>.md`),
   then the check once more. Still failing ⇒ the Lead fixes it itself or re-slices. Never a third worker round.
6. **Lead acceptance:** read the diff (not the logs), run `pnpm check` + e2e **once** on the final candidate, push the
   branch, open the PR, merge when CI is green. One PR per slice; small fixes/docs batch into one PR per round.

## Review by risk

- **Ordinary** (UI, read-only views, tests, docs): handoff-check + Lead diff read + CI. PR-level CodeRabbit is
  optional and **never a merge gate**.
- **High-risk** — new vault write target, write/CAS/dedupe/receipt path, auth/Access, privacy boundary,
  concurrency/queue: add **one** independent review of the risky diff only. If a worker wrote it, the Lead's own
  focused review is that review (different model family). If the Lead wrote it, one DeepSeek Pro medium review with
  a packet of the risky diff + the invariant. Plus negative tests that fail when the guard breaks.
- **Findings are fixed once and verified by the Lead.** A fix does not trigger a new full review unless it rewrites
  the risky logic. No review chains, no "floor" that blocks delivery when a provider is out of credit: reroute.

## Jev (cheap typed judgments, use freely)

Jev (`Tools/jev.ps1` in the vault, pinned `jev-1.13.0`, ~400 tokens a call) replaces model reasoning wherever the
question is a typed choice/score/yes-no over **public repo** material:
- **Automatic:** CodeRabbit finding triage inside `handoff-check.ps1` (critical/major always fix; Jev decides the rest).
- **Before dispatch:** `-Choose` the worker tier for a brief (`gemini`, `glm`, `flash`, `pro`, `unresolved`).
  Deterministic floor wins: high-risk work is never routed below Pro/Lead review.
- **Anywhere cheap triage helps:** "is this in scope?", "is this handoff claim supported by the test output?".
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
- Commit state only at milestones (merge, pause, end of session): overwrite `docs/checkpoint.md`. No docs commit per event.
- After each merged slice, start a **fresh Lead session** from the checkpoint instead of carrying a long context.
- Do not build orchestration tooling unless the owner asks for it. The tools here are enough.

## Authority

The Lead may push branches, open/close PRs and merge them. **Deploys, live/reference vault writes, credential,
Access and billing changes need the owner's explicit approval each time.** The Lead prepares the exact deploy
command and asks with a line starting `ACTION NEEDED:`.

## Herdr

Run the Lead in its own Herdr pane; workers appear in the **Agents** tab via `tools/agent-pane.sh`. Never navigate
or close panes the Lead did not create. Never end a Claude agent with `/exit`; close its pane instead.
Git Bash rewrites `/word` arguments: prefix slash commands with `MSYS_NO_PATHCONV=1`.
