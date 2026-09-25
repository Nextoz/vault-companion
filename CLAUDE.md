# Claude Code entry point

@AGENTS.md

- **On resume, follow the resume procedure in `docs/orchestration.md`** (git state → `docs/checkpoint.md` → `docs/plan.md` → Herdr workers).
- Current milestone and ownership: `docs/plan.md`; checkpoint: `docs/checkpoint.md`. Keep both current; commit at stable points.
- Orchestration and **model routing** (Lead = Claude Opus 5.5; Codex `gpt-6-astra` for cross-model/adversarial
  review, `gpt-6-sol` for routine bounded work; always pass the model explicitly): `docs/orchestration.md`.
- **Cloud tasks must push their branch without being asked.** The Lead sees only what is on GitHub
  (`Nextoz/vault-companion`), never the container. A task isn't done until its branch is pushed. If `origin` is
  missing or a push is refused, say so in the task's final line and stop. Launch cloud tasks with the repo as
  the session source so `origin` exists from the start.
- Windows: force UTF-8 in any Python/PowerShell tooling (cp1252 stdout corrupts emoji markers).
- Keep `docs/learning-guide.md` (owner's learning map) current at **major** architecture changes only: concepts
  implemented, 3–5 key files each, one trace path, decisions and why, self-check questions. No tutorial, no duplication.
- Tool inputs convert `\uXXXX` escapes into literal characters. Never type ` `/` `/control-char escapes in
  Write/Edit/Bash content; generate them from code points (`String.fromCharCode`) and re-scan
  (U+2028 inside a regex literal is a syntax error; elsewhere it is an invisible character).
