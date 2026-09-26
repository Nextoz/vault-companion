# ADR-0018 — Local Lead may read a bounded part of the live vault

**Status:** accepted (owner decision, 2026-09-26). Amends AGENTS.md rule 1 and the bootstrap's "initial phases"
restriction.

## Decision

The **local Lead only** may **read** the live vault, read-only, limited to:

- `Projects/Vault Companion/**` (product decisions: the Ready Backlog is the source of truth for priority);
- `Tasks/Active Work Now.md` and `Tasks/To-Do List.md` (real shapes for increments C and D);
- `Tools/*.state.json` and `Automation/Scout Status/**` once it exists (real shapes for increment S).

Unchanged:
- **No writes** to the live vault except through the app's own write path (commands, receipts, trailers).
- **No private vault text in this repository** (rule 2): briefs, fixtures, tests, logs and commit messages stay
  synthetic. Real files inform *shapes* only; fixtures copy the shape with invented values.
- **No live-vault access for cloud or other-vendor workers** (Claude Cloud, Codex, Antigravity, Qwen, Jev). They get
  synthetic briefs only.

## One writer per file

- Product decisions and priority: the vault note `Projects/Vault Companion/Vault Companion - Ready Backlog.md`.
  The owner writes it; the Lead reads it and never edits it.
- Engineering status: `docs/plan.md`. Only the Lead writes it; it links to the Ready Backlog instead of copying
  decisions.

## Why

Deriving fixtures from real file shapes (not guesses) and reading the owner's priorities directly removes a class
of relay errors, while writes, private text and third-party exposure stay exactly as restricted as before.
