# Vault Companion — engineering constitution

Private mobile execution layer over an Obsidian vault. **Markdown + Git are authoritative.**

## Read first

`docs/product-contract.md` (scope) · `docs/vault-contract.md` (exact Markdown rules) ·
`docs/commands.md` (retry/receipts) · `docs/architecture.md` · `docs/plan.md` (current work) ·
`docs/orchestration.md` (roles, model routing, Herdr mechanics).

## Non-negotiables

1. Never write to `C:\Dev\vault-companion-vault-reference` or the live vault. Live writes need the owner's approval.
2. No private vault text in this repository: fixtures, tests, logs, screenshots, commit messages are synthetic.
3. Mutations are minimal span splices with exact golden-diff tests. Unsupported ⇒ typed refusal, never a guess.
4. Every write: operation ID, base revision, CAS on blob SHA, commit trailers, dedupe before write.
5. `packages/domain` and `packages/vault-markdown` import no React/Hono/Cloudflare/GitHub code.
6. No secrets in code; no task/note text in logs.
7. A test must fail when the production guard it covers is broken.
8. Consequential choices ⇒ ADR in `docs/decisions/`. Keep `docs/plan.md` current.

## Commands

`pnpm install` · `pnpm check` (lint + typecheck + test) · `pnpm test` · `pnpm build`.
