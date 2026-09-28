# Checkpoint — 2026-09-28 night (Lead session `6f65db54`, Herdr agent `lead`, overnight autonomous run)

Read this first, then `docs/plan.md`, then `docs/orchestration.md` (routing, Herdr, Cloud, token + RAM rules).
Priority and product decisions: the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). Engineering status: `docs/plan.md` (Lead writes it).

## Deployed (verified)

- `main` = `8a5ca2d` (PR #36 C2 + S2a + C3), Worker `vault-companion` **version `0e34d79f`** at `https://app.karpov.dk`
  (Workers Free, Cloudflare Access owner-only). Anonymous `/` and `/api/*` → 302 after the deploy.
- Deploy runbook: `rm -rf apps/web/dist && pnpm build` — **check the build succeeded before deploying** (Windows `EBUSY`
  on `copyfile` of an icon happened again 2026-09-28: retry the clean build), `wrangler deploy --dry-run`, then
  `cd apps/worker && pnpm exec wrangler deploy --domain "app.karpov.dk"`, then `curl` the anonymous 302.
- T (swipe triage) is live; the owner did not see it. Diagnosis (counts only): `Events/Triage/feed.json` is on the vault
  remote, 92 valid cards, 0 dropped, all future, no decisions ⇒ the app shows "10 new events" on **Today** (daily cap 10).
  Likely an old cached build on the phone; ask the owner to reload (update banner) and report what Today shows.

## Owner decisions this session

- Overnight: merge + deploy engineering work when green; Scout insights v1 built and deployed for live testing.
- New README (Gemini worker), everything the app can do, modelled on popular READMEs.
- Ready Backlog **L — Training log** is next (order: after #36). ADR-0025 written by the Lead.
- Workers start without memory; use matching Claude Code plugins/skills (Lead memory `agents-no-memory-use-plugins`).

## Workers (Herdr workspace w4, Agents tab)

| Pane | Worker | Clone / branch | Brief |
|---|---|---|---|
| w4:p3 | Codex `gpt-6-astra` high | `vault-companion-clones/training`, `agent/training` | `.agent/brief.md` (L, ADR-0025) |
| w4:p4 | Codex `gpt-5.6-sol` medium | `vault-companion-clones/insights`, `agent/insights` | `.agent/brief.md` (Scout insights v1) |
| w4:p5 | Gemini `gemini-3.8-flash` | `vault-companion-clones/readme`, `agent/readme` | `.agent/brief.md` (README) — first run hit 503, retried |

Each writes `.agent/report.md` ending in `… DONE` / `… BLOCKED`. Workers do not push; the Lead reviews, runs the full
check + e2e (one Playwright job at a time), pushes, opens the PR, requests `@coderabbitai full review` once.

## Next actions

1. Integrate each worker as it finishes (L first priority): review diff (adversarial review of the new `Health/` write
   target for L), `pnpm check`, e2e, PR, CodeRabbit, merge, deploy.
2. After a push, check `gh pr view --json mergeStateStatus`: a conflicting PR runs **no CI** (lost ~1 h on #36).
3. Leftovers if quota allows: edited task briefly renders twice (B), R7 blank line, Dependabot #29.
4. Morning: owner phone tests T (reload first), C2, S2a, C3, L, Scout insights; confirm L's written-row format
   (numbers without units) matches the converted vault table.
5. Owner decision still open: G3.
