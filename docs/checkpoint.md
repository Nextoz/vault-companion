# Checkpoint — 2026-09-28 ~16:15 (Lead session `6f65db54`, Herdr agent `lead`)

Read this first, then `docs/plan.md`, then `docs/orchestration.md` (routing, Herdr, Cloud, token + RAM rules).
Priority and product decisions: the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). Engineering status: `docs/plan.md` (Lead writes it).

## Deployed (verified)

- ## Deployed (verified)

- `main` = `ea016bf` (PR #42 Progress Wall), Worker **version `d4403dcd`** at `https://app.karpov.dk`; anonymous → 302.
- Live today: training units (#40), T2 triage check-ins/summary/overlap tags/reasons that stay (#41), Progress Wall
  inside History (#42). Deploy runbook unchanged (clean build, check `sw.js`, dry run, deploy, 302).
- The real triage feed does not yet carry `summary`/`checkins`/`clash.kind`: verify shapes when it does.

## Open work (exact next actions)

1. **PR #43 (agent/lease, clone `vault-companion-clones/lease`) = ADR-0028 lease reclaim.** CodeRabbit requested ~16:15
   (re-request if rate-limited). Before merge: full check + full e2e on the merged tree (last run had 2 timeouts while
   the PC slept; both 6/6 on rerun).
2. **Research Radar — owner chose option A + fallback (2026-09-28):** the research scout writes a structured
   `radar.json` (topics + counts + 3–5 highlights with a one-line why) via one AI step; the app renders overview →
   highlights → depth + promote; a deterministic fallback from the daily notes until then. Owner wants it to run
   **independent of the PC** and a model fallback (Gemini → Codex/Claude): design options in the reply of 16:15
   (Cloudflare Cron Trigger + Workers AI). Pending: owner OK to read `Research/Daily Research Scout/**` (ADR-0018
   amendment) for the note shape.
3. Owner phone tests: Training (units), Progress, triage (reasons, overlap tag), Scout insights.
4. Owner decisions open: AGENTS.md rule 4 wording (head-CAS), G3.
5. Engineering (no decision): R3 CPU via `wrangler tail` during owner use, Progress events > 2 months (server window),
   `docs/learning-guide.md`, stale items in `docs/plan.md`, close Dependabot #29.

ing

- No workers running. Codex: **weekly limit, out until 2026-10-03 21:29**. Use Claude Code Cloud (features), local Claude Code
  workers (fixes/reviews), Gemini via tools/gemini-worker.sh (small jobs); ChatGPT relay only for critical reviews.
- **Codex quota out until 2026-09-28 08:16** (hit during the L fix run; the Lead finished and verified the fixes).
  Gemini CLI returned 503 twice tonight (README rerouted to Codex Terra). CodeRabbit: 1 full review/hour.
- Codex sandbox cannot write `.git` (index.lock denied): workers leave changes uncommitted, the Lead commits.
  Codex workers also cannot run `tsc -b` project references (TS6305): the Lead's full check catches type errors.
- Owner's tools fixed 2026-09-27: Python 3.13 on user PATH, jq installed (new shells only).
- RAM: one Playwright job at a time; `PW_PREVIEW_PORT=4191` for the Lead's runs.
- Local-only files never committed: `.claude/`.
