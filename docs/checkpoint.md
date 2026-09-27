# Checkpoint — 2026-09-27 evening (Lead handover to a fresh session)

Read this first, then `docs/plan.md`, then `docs/orchestration.md` (routing, Herdr, Cloud, token + RAM rules).
Priority and product decisions: the owner's vault note *Projects/Vault Companion/Vault Companion - Ready Backlog*
(read-only for the Lead, ADR-0018). Engineering status: `docs/plan.md` (Lead writes it).

## Deployed (verified)

- `main` = `5d9163e`, Worker `vault-companion` **version `667e23c9`** at `https://app.karpov.dk` (Workers Free,
  Cloudflare Access owner-only). Anonymous `/` and `/api/*` → 302 after every deploy.
- Live: tasks (Today/Overdue/All, complete, Undo, capture), linked notes, vault status line (A), task editing (B,
  ADR-0017), Active Work in the app (C, ADR-0019), Scouts page (S2, ADR-0020), History (D, ADR-0021), Notes list/view/edit
  (N, ADR-0022), R7/edit-double-row fixes (ADR-0023), **event swipe triage (T Part 2, ADR-0024)**, update banner.
- Deploy runbook: `rm -rf apps/web/dist && pnpm build` — **check the build succeeded before deploying** (a Windows
  `EBUSY` lock once produced a partial build without `sw.js`; retry the build), then
  `cd apps/worker && pnpm exec wrangler deploy --domain "app.karpov.dk"`, then `curl` the anonymous 302.

## Open work (exact next actions)

1. **PR #36 (branch `agent/c2`) = C2 + S2a + C3 combined** (owner bug reports from phone use, Ready Backlog):
   C2 Done/Park/Drop any time; S2a scout findings as stacked cards + human-friendly times; C3 Add opens with the tab's
   capture kind. Each part tested individually; the **combined full check + WebKit e2e was stopped by low RAM** — rerun
   in clone `C:\Dev\vault-companion-clones\fixes` with `PW_PREVIEW_PORT=4191`, then request `@coderabbitai full review`
   once, fix findings, merge, deploy, give the owner phone steps (C2, S2a, C3, plus T swipe triage).
2. **Owner phone tests pending:** C, S2, D, N, T (swipe: Today "N new events" → date-first card stack), C2/S2a/C3.
3. Backlog: O4 (harness via createProductionApp, RAM-heavy), R3 (CPU re-measure with `wrangler tail` while the owner
   uses the app), "scout insights" (owner refines after the scout review).
4. Owner decision still open: G3 (count the owner's live writes as the canary?).

## Workers, capacity, tooling

- **No workers running. No scheduled loops** (session crons die with the session).
- Codex (ChatGPT Plus, one shared quota): **out until 2026-09-28 01:45**. Models: `gpt-5.6-luna` / `gpt-5.6-terra` /
  `gpt-5.6-sol` / `gpt-6-astra`; always memories off. **Gemini CLI** works (key via `AGENT_USER_ENV=GEMINI_API_KEY`).
  Claude Cloud ~$10: push works after the owner writes "you may push" in the session. Antigravity out until ~10-03.
  CodeRabbit: 1 full review/hour.
- RAM is the main local bottleneck: one Playwright job at a time; close finished Agents panes; use `PW_PREVIEW_PORT`.
- Clones under `C:\Dev\vault-companion-clones\` (delete logs after merges; old clones can be removed).
- Local-only files never committed: `.claude/` (owner permission rules incl. the agent-pane allow rule).
