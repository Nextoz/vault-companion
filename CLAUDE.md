# Claude Code entry point

@AGENTS.md

- Current milestone and ownership: `docs/plan.md`. Update it when work is delegated, integrated or reviewed.
- Orchestration and **model routing** (Lead = Claude Opus 5.5; Codex `gpt-6-astra` for cross-model/adversarial
  review, `gpt-6-sol` for routine bounded work; always pass the model explicitly): `docs/orchestration.md`.
- Windows: force UTF-8 in any Python/PowerShell tooling (cp1252 stdout corrupts emoji markers).
