# Checkpoint — 2026-09-28 ~17:00 (handover to a fresh Lead session; previous `6f65db54`)

Read this first, then `docs/plan.md`, then `docs/orchestration.md` (routing, Herdr, Cloud, token + RAM rules).
Priority and product decisions: the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). Engineering status: `docs/plan.md` (Lead writes it).

## Deployed (verified)

- ## Deployed (verified)

- `main` = `ea016bf` (PR #42 Progress Wall), Worker **version `d4403dcd`** at `https://app.karpov.dk`; anonymous → 302.
- Live today: training units (#40), T2 triage check-ins/summary/overlap tags/reasons that stay (#41), Progress Wall
  inside History (#42). Deploy runbook unchanged (clean build, check `sw.js`, dry run, deploy, 302).
- The real triage feed does not yet carry `summary`/`checkins`/`clash.kind`: verify shapes when ## Open work (exact next actions)

1. **R1 research explainer (ADR-0029, brief `docs/briefs/R1-research-explainer.md`)** — Claude Cloud session
   `session_01DkecfJ8rFD2rk6NrQFXBoM`, branch `agent/explainer` (owner approved push). When its handoff ends
   `R1 DONE`: clone, review (write targets `Research/Explained/*.md` create-only + `Automation/Scout Status/research-explainer.json`,
   Gemini client, cron), `pnpm check` + e2e, PR, one CodeRabbit review, merge; then set the Worker secret
   (`GEMINI_API_KEY` from the owner's Windows user env, piped, never printed — `wrangler secret put` deploys a version),
   clean build, deploy, 302 check, and watch the first cron run (04:30 UTC) on the Scouts page.
2. **PR #43 lease reclaim (ADR-0028, clone `vault-companion-clones/lease`)** — CodeRabbit requested ~16:15 (re-request if
   rate-limited); before merge run full check + full e2e on the merged tree; then merge + deploy.
3. **Next product work (owner, 2026-09-28): the morning check.** The owner opens the app in the morning to see all
   scout results, the morning digest, research explanations, and tasks/actions. Part 2 = "This morning" section on
   Today (morning digest short answer, new `Research/Explained` notes, scout attention, "N new events", today's tasks).
   Then **Research Radar** (owner chose option A + deterministic fallback; overview → highlights → depth + promote;
   research hub shapes: Reading Briefs `## Read today`/`## Read this week`, Daily Research Scout `## Most relevant items`,
   `Important Research Updates/`, `Research Intake/`, `AI Research Radar - Living Updates.md`). Brief and build these
   after the Claude weekly reset (Wed 1 Oct 21:00) or with Codex/DeepSeek.
4. Owner phone tests pending: training units, Progress, triage (reasons, overlap tag), Scout insights.
5. Owner decisions open: AGENTS.md rule 4 wording (head-CAS instead of "CAS on blob SHA"), G3.
6. Engineering (no decision): R3 CPU via `wrangler tail`, Progress events > 2 months (triage decision window),
   `docs/learning-guide.md` (overdue after L, T2, P, R1), stale items in `docs/plan.md` (R7 and edit double-row were fixed
   in #34), close Dependabot #29.

## Capacity (2026-09-28)

- **Claude pool** (Lead + local workers + Cloud + claude.ai share it): 5-hour window 84 % used at 17:07 (resets 18:10),
  **weekly 72 %** (resets Wed 1 Oct 21:00). Until then: integration and bug fixes only; one Claude worker at a time.
- **Codex:** weekly limit, back **Fri 3 Oct 21:29**. **Antigravity** (`agy`): back ~3 Oct, small jobs only.
- **DeepSeek API from Wed 1 Oct** (owner): key as Windows user env `DEEPSEEK_API_KEY` with a spending cap; choose a
  harness (opencode or Claude Code against DeepSeek's API), build a wrapper like `tools/gemini-worker.sh`, test on one
  small task; route ordinary builds/fixes to it. Lead stays **Claude Opus 5.5** (owner).
- **Gemini** via `tools/gemini-worker.sh` (Flash-Lite first) works for small jobs.
- Owner wants a line starting **"ACTION NEEDED:"** whenever they must act; none ⇒ nothing to do.


