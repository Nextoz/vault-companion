# Claude Code entry point

@AGENTS.md

- Current milestone and ownership: `docs/plan.md`. Update it when work is delegated, integrated or reviewed.
- Orchestration and **model routing** (Lead = Claude Opus 5.5; Codex `gpt-6-astra` for cross-model/adversarial
  review, `gpt-6-sol` for routine bounded work; always pass the model explicitly): `docs/orchestration.md`.
- Windows: force UTF-8 in any Python/PowerShell tooling (cp1252 stdout corrupts emoji markers).
- Keep `docs/learning-guide.md` (owner's learning map) current at **major** architecture changes only: concepts
  implemented, 3–5 key files each, one trace path, decisions and why, self-check questions. No tutorial, no duplication.
- Tool inputs convert `\uXXXX` escapes into literal characters. Never type ` `/` `/control-char escapes in
  Write/Edit/Bash content; generate them from code points (`String.fromCharCode`) and re-scan
  (U+2028 inside a regex literal is a syntax error; elsewhere it is an invisible character).
