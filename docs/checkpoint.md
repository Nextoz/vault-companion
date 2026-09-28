# Checkpoint — 2026-09-28 ~05:45 (Lead session `6f65db54`, Herdr agent `lead`, overnight autonomous run)

Read this first, then `docs/plan.md`, then `docs/orchestration.md` (routing, Herdr, Cloud, token + RAM rules).
Priority and product decisions: the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). Engineering status: `docs/plan.md` (Lead writes it).

## Deployed (verified)

- `main` = `dd6e3e9` (PR #39 L Training log), Worker `vault-companion` **version `ea770cc2`** at `https://app.karpov.dk`
  (Workers Free, Cloudflare Access owner-only). Anonymous `/` and `/api/*` → 302 after the deploy.
- Live since the owner's last phone use: C2 + S2a + C3 (#36), Scout insights v1 (#38), L Training log (#39). README (#37).
- Deploy runbook: `rm -rf apps/web/dist && pnpm build` — **check the build succeeded** (Windows `EBUSY` on an icon
  `copyfile` recurs: retry the clean build), `wrangler deploy --dry-run`, then
  `cd apps/worker && pnpm exec wrangler deploy --domain "app.karpov.dk"`, then `curl` the anonymous 302.
- T (swipe triage) is live; the owner did not see it. Counts-only check: `Events/Triage/feed.json` on the vault remote,
  92 valid cards, 0 dropped, all future, no decisions ⇒ Today should show "10 new events" (daily cap 10). Likely an
  old cached build on the phone: owner reloads (update banner) and reports what Today shows.

## Open work (exact next actions)

1. Codex back 08:16: launch the leftovers (item 4) one PR each.
2. Morning, owner phone tests: T (reload first), C2, S2a, C3, Scout insights, L. Owner confirms L's written row format
   (numbers without units, e.g. `| 2026-09-28 | 18:42 | Run | 5.2 | 28 | | | … |`) against the converted vault table —
   the Lead may not read `Health/` (outside ADR-0018); a one-function change if units are wanted.
3. Owner decision: AGENTS.md rule 4 still says "CAS on blob SHA"; ADR-0011 replaced it with head-CAS. Owner approves
   the wording fix (constitution file).
4. Leftovers (Codex back 08:16): edited task briefly renders twice (B), R7 blank line, Dependabot #29 (@types/node 26
   vs Node 24 runtime — recommend ignoring the major until the runtime moves).
5. Owner decision still open: G3.

## Workers, capacity, tooling

- No workers running. Herdr w4 panes of finished workers have closed themselves.
- **Codex quota out until 2026-09-28 08:16** (hit during the L fix run; the Lead finished and verified the fixes).
  Gemini CLI returned 503 twice tonight (README rerouted to Codex Terra). CodeRabbit: 1 full review/hour.
- Codex sandbox cannot write `.git` (index.lock denied): workers leave changes uncommitted, the Lead commits.
  Codex workers also cannot run `tsc -b` project references (TS6305): the Lead's full check catches type errors.
- Owner's tools fixed 2026-09-27: Python 3.13 on user PATH, jq installed (new shells only).
- RAM: one Playwright job at a time; `PW_PREVIEW_PORT=4191` for the Lead's runs.
- Local-only files never committed: `.claude/`.
