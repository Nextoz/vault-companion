# Vault Companion — engineering constitution

Private mobile execution layer over an Obsidian vault. **Markdown + Git are authoritative.**

## Where things are (read only what your task touches)

`docs/checkpoint.md` (current state, next action) · `docs/orchestration.md` (roles, workers, delivery loop) ·
`docs/product-contract.md` (scope) · `docs/vault-contract.md` (exact Markdown rules) ·
`docs/commands.md` (retry/receipts) · `docs/architecture.md`.

## Non-negotiables

1. Never write to `C:\Dev\vault-companion-vault-reference` or the live vault. Live writes need the owner's approval.
   Only the local Lead may **read** task-relevant live vault sources, read-only, per amended ADR-0018
   (`docs/decisions/0018-lead-live-vault-read-access.md`); never cloud or other-vendor workers.
2. No private vault text in this repository: fixtures, tests, logs, screenshots, commit messages are synthetic.
3. Mutations are minimal span splices with exact golden-diff tests. Unsupported ⇒ typed refusal, never a guess.
4. Every write: operation ID, base revision, CAS on blob SHA, commit trailers, dedupe before write.
5. `packages/domain` and `packages/vault-markdown` import no React/Hono/Cloudflare/GitHub code.
6. No secrets in code; no task/note text in logs.
7. A test must fail when the production guard it covers is broken.
8. Consequential choices ⇒ ADR in `docs/decisions/`. Current state lives only in `docs/checkpoint.md`.

## Worker token economy (every delegated agent)

Tokens are a hard budget. The Lead runs the full `pnpm check` and e2e before merging; workers do not.
- Read only the files your brief names, and only the needed ranges (`rg -n`, then a line window) — never whole docs.
- Tests: run only the touched test files (`pnpm exec vitest run <files> --reporter=dot`), plus `pnpm -r exec tsc --noEmit`.
  Never run the full `pnpm check`/e2e unless the brief says so. Pipe long output: `… 2>&1 | Select-Object -Last 30`.
- Don't re-read files you just edited; don't repeat a passing command. Stop when the acceptance checks pass.
- Handoff ≤ 15 lines.

## Commands

`pnpm install` · `pnpm check` (lint + typecheck + test) · `pnpm test` · `pnpm build`.
