# Brief C — CI pipeline (GitHub Actions) + identical local check

Type: **implementation** (bounded, routine). Branch `agent/ci`, worktree `C:\Dev\vault-companion-worktrees\ci`.
Model routing: Codex **GPT-6 Sol**.

## Objective

1. `.github/workflows/ci.yml`, triggered on `push` and `pull_request`, with `permissions: contents: read` only.
   Runs on `ubuntu-latest` **and** `windows-latest`, since the owner's desktop is Windows and EOL/path behaviour matters.
   Steps: checkout; pnpm (version from root `package.json` `packageManager`); Node 24 with the pnpm cache;
   `pnpm install --frozen-lockfile`; `pnpm lint`; `pnpm typecheck`; `pnpm test`; Playwright WebKit install + web e2e
   (`pnpm --filter @vault-companion/web e2e`) on ubuntu only; `pnpm audit --prod --audit-level high`;
   a gitleaks scan (pinned action) on ubuntu only.
2. Pin **every** third-party action to a full commit SHA with a trailing `# vX.Y.Z` comment (threat model T15).
   Resolve the SHAs from the real upstream tags (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`); never invent them.
3. Root script `pnpm ci:local` that runs the same checks locally in the same order (lint, typecheck, test, e2e,
   audit), so CI cannot drift from what developers run.
4. Real-Git tests need `git` with `user.name`/`user.email` available in CI. Check that the tests set these
   themselves; if not, add a CI step. Do not edit tests to make CI pass.

## May change

`.github/**`, root `package.json` (the `scripts` field only), `docs/briefs/C-report.md` (your report).

## Must not change

Everything else. No `git push`, no remote, no network writes. Do not create GitHub repositories.

## Verify

Run `pnpm ci:local` in your worktree (all green). Validate the workflow YAML with `actionlint` if available
(`npx --yes @action-validator/cli` or `go run` are fine), else parse it with a YAML parser, and report which was used.

## Report

`docs/briefs/C-report.md`: what was added, action SHAs and how each was resolved, local run results, and anything
that could not be verified without a remote. Commit on `agent/ci`. Print one line at the end:
`C DONE <commit-sha> — docs/briefs/C-report.md`.
