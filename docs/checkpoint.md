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

1. **R1 research explainer (ADR-0029 + amendments 1, 2)** — **merged** as PR #45 (`ae5d438`; CodeRabbit 2 minor
   fixed; check 1409, e2e 77). **Deployed 2026-09-29: version `bd9ed7ad`** (302 OK), then `GEMINI_API_KEY` set as a
   Worker secret (new version). Live Gemini verified 2026-09-28 (gemini-3.5-flash-lite read an arXiv PDF via url_context,
   JSON validated by zod; evenings often 503). **Crons registered 2026-09-29** after the owner opened Workers & Pages (creates the account workers.dev
   subdomain; Cloudflare refuses schedules without it). Live version `3f5f38a9`, 302 OK. Verified via API: script
   workers.dev `enabled:false`, previews `false`, `vault-companion.<sub>.workers.dev` → 404; schedules `30 4`, `30 6`. The
   new dashboard has no "Domains & Routes" under Settings (docs/deploy.md step 8 is stale; the API check replaces it).
   Next: first run 2026-09-30 04:30 UTC → check `Research/Explained/` + Scouts page. CPU per run: measure with `wrangler tail`.
   No more Claude Cloud sessions (owner). Dependabot #29 closed.
2. **PR #43 lease reclaim (ADR-0028)** — **merged 2026-09-28 (`7c5309e`)** after the CodeRabbit ADR fix, full check
   (1355) and full e2e (77) on the merged tree. **Deployed** by the owner: version `12692438`, anonymous 302 OK. The
   Lead may now deploy: `.claude/settings.local.json` allows `pnpm exec wrangler deploy *` (owner, 2026-09-28).
   R1 session was blocked by its own classifier (remote repoint / "Data Exfiltration"); owner re-approved in-session.
   ADR-0029 amended (`1d0eac2`) with the worker's three design answers. Open bug **B1** (Danish comma in weight/distance:
   `type="number"` rejects `84,5`; fix = text input + `inputMode="decimal"` + comma→dot), batched with further bugs.
3. **Next product work (owner, 2026-09-28): the morning check.** The owner opens the app in the morning to see all
   scout results, the morning digest, research explanations, and tasks/actions. Part 2 = "This morning" section on
   Today (morning digest short answer, new `Research/Explained` notes, scout attention, "N new events", today's tasks).
   **Shape (owner, 2026-09-28):** one tappable panel like the scout panels: collapsed = a short brief; expanded = all
   morning reading — the morning Reading Brief itself plus today's explanations (pending ones shown as pending).
   Then **Research Radar** (owner chose option A + deterministic fallback; overview → highlights → depth + promote;
   research hub shapes: Reading Briefs `## Read today`/`## Read this week`, Daily Research Scout `## Most relevant items`,
   `Important Research Updates/`, `Research Intake/`, `AI Research Radar - Living Updates.md`). Brief and build these
   after the Claude weekly reset (Wed 1 Oct 21:00) or with Codex/DeepSeek.
4. Owner phone tests pending: training units, Progress, triage (reasons, overlap tag), Scout insights.
5. Owner decisions open: AGENTS.md rule 4 wording (head-CAS instead of "CAS on blob SHA"), G3.
6. Engineering (no decision): R3 CPU via `wrangler tail`, Progress events > 2 months (triage decision window),
   `docs/learning-guide.md` (overdue after L, T2, P, R1), stale items in `docs/plan.md` (R7 and edit double-row were fixed
   in #34), close Dependabot #29.
7. **Code tour for the owner (owner, 2026-09-28; start after the Wed 1 Oct 21:00 reset, Lead writes it).** The owner
   understands the spec but wants to understand the implementation as a developer and DevOps engineer. Markdown in the repo,
   `docs/code-tour/*.md`, with clickable `path:line` anchors (verified against the code, not the spec). First two chapters:
   (a) **request lifecycle**: phone tap → offline queue (lease, claim lock) → Worker API boundary → Markdown span splice →
   GitHub head-CAS commit with trailers → receipt/undo; (b) **DevOps**: monorepo/packages, build, CI, Cloudflare Worker +
   Access, secrets, deploy runbook, service-worker updates, cron jobs. Each chapter: what runs where, the 5–8 files that
   matter, one traced path, why it was built this way (link the ADR), self-check questions. Then refresh
   `docs/learning-guide.md` to point at the tour instead of duplicating it. Later chapters: features since 25 Sep, testing.
   Reader: the owner on a computer (VS Code), experienced engineer but **new to TypeScript**. So: chapter 0 is a short
   "TypeScript you need for this repo" (only what the code uses: types/interfaces, Zod schemas as runtime checks,
   discriminated unions, async/await, `#private` fields, `satisfies`/generics as met), each shown on a real line of this
   repo; every chapter marks what to **read closely** vs **skim** vs **skip** (boilerplate, UI styling, test helpers), so
   no time is wasted on unimportant code.

## Capacity (2026-09-28)

- **Claude pool** (Lead + local workers + Cloud + claude.ai share it): 5-hour window 84 % used at 17:07 (resets 18:10),
  **weekly 72 %** (resets Wed 1 Oct 21:00). Until then: integration and bug fixes only; one Claude worker at a time.
- **Codex:** weekly limit, back **Fri 3 Oct 21:29**. **Antigravity** (`agy`): back ~3 Oct, small jobs only.
- **DeepSeek API from Wed 1 Oct** (owner): key as Windows user env `DEEPSEEK_API_KEY` with a spending cap; choose a
  harness (opencode or Claude Code against DeepSeek's API), build a wrapper like `tools/gemini-worker.sh`, test on one
  small task; route ordinary builds/fixes to it. Lead stays **Claude Opus 5.5** (owner).
- **Gemini** via `tools/gemini-worker.sh` (Flash-Lite first) works for small jobs.
- Owner wants a line starting **"ACTION NEEDED:"** whenever they must act; none ⇒ nothing to do.


