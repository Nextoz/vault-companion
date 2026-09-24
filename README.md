# Vault Companion

A private, mobile-first PWA for everyday action on an existing Obsidian vault: see today's tasks,
complete and undo them, and capture tasks and thoughts from a phone — while the vault's Markdown in
Git stays the only source of truth.

**Problem it solves:** Obsidian on a phone is a poor interface for quick execution, and ad-hoc AI edits
to the task list are unsafe. Vault Companion applies small, verified, minimal-diff Git commits instead,
with honest save/conflict states and no second database.

**Status:** Phase 0 reviewed and reconciled; Phase 1 (safe kernel + phone shell) in progress.
See `docs/plan.md`.

## Run

```sh
pnpm install
pnpm check      # lint + typecheck + tests
```

## Docs

`docs/product-contract.md`, `docs/vault-contract.md`, `docs/architecture.md`, `docs/sync.md`,
`docs/commands.md`, `docs/security.md`, `docs/threat-model.md`, `docs/testing.md`, `docs/decisions/`.
