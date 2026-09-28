# Claude Code entry point

@AGENTS.md

- **On resume, follow the resume procedure in `docs/orchestration.md`** (git state → `docs/checkpoint.md` → `docs/plan.md` → Herdr workers).
- Current milestone and ownership: `docs/plan.md`; checkpoint: `docs/checkpoint.md`. Keep both current; commit at stable points.
- Orchestration and **model routing**: `docs/orchestration.md` is the single source of truth. Lead = Claude
  Opus 5.5; workers use the cheapest capable tier from that file. Always pass Codex model + effort explicitly and
  verify both in the worker log; do not duplicate routing tables here.
- Windows: force UTF-8 in any Python/PowerShell tooling (cp1252 stdout corrupts emoji markers).
- Keep `docs/learning-guide.md` (owner's learning map) current at **major** architecture changes only: concepts
  implemented, 3–5 key files each, one trace path, decisions and why, self-check questions. No tutorial, no duplication.
- Tool inputs convert `\uXXXX` escapes into literal characters. Never type ` `/` `/control-char escapes in
  Write/Edit/Bash content; generate them from code points (`String.fromCharCode`) and re-scan
  (U+2028 inside a regex literal is a syntax error; elsewhere it is an invisible character).
