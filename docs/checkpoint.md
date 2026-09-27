# Checkpoint — 2026-09-27 (milestone 3: owner order B → C → S Part 2 → D delivered)

Resume procedure: `docs/orchestration.md`. Engineering status: `docs/plan.md`. Priority: the owner's vault note
*Projects/Vault Companion/Vault Companion - Ready Backlog* (Lead reads it read-only, ADR-0018).

## Deployed

- `main` = `a0a616f`; Worker `vault-companion` **version `73af3631`** at `https://app.karpov.dk` (Workers Free,
  Access owner-only). Anonymous `/`, `/api/*` → 302 (verified after every deploy).
- Live features: tasks (Today/Overdue/All, complete, Undo, capture), linked notes, vault status line + Refresh (A),
  task editing (B, ADR-0017), Active Work in the app (C, ADR-0019), Scouts page (S Part 2, ADR-0020), History (D,
  ADR-0021), "New version — tap to reload" banner.

## Verified

- Every feature PR: full `pnpm check` + full WebKit e2e locally, CI ubuntu + windows, CodeRabbit real review (findings
  fixed with mutation-checked tests) or recorded "rate limited — not a pass".
- Owner phone: A and B used live (B edit reached GitHub as a one-line commit; desktop sync is hourly at :06).
- Not yet phone-tested by the owner: C, S Part 2, D.

## Open

- Owner: phone tests of C/S2/D; C review-date trial (~2 weeks); G3 decision (count the owner's live writes as canary?).
- Technical follow-ups in `docs/plan.md` (R3 CPU re-measure, O8, O4, R7, B transient double row).
- Next increment: owner picks from the Ready Backlog.

## Workers and tooling

- No workers running. Agents launch via `tools/agent-pane.sh` (visible, self-closing panes).
- Codex: memories OFF for repo workers (flags in orchestration) — **verified 2026-09-27** (triage-ui run: 0 memory references).
- Claude Cloud: push works after the owner writes one line in the session page ("you may push").
- Antigravity free quota out until ~2026-10-03. CodeRabbit: 1 review/hour. RAM: ≤ 1 Playwright job at a time.
- Clones under `C:\Dev\vault-companion-clones\` (logs deleted after merge); they can be removed.
