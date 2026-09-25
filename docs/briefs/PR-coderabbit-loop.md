# Brief PR — address CodeRabbit review on one pull request (reusable)

Type: **review follow-up**. Input: a PR number `<N>` on `Nextoz/vault-companion` and its head branch.
Runs on Claude Code Cloud (substantive changes) or Codex GPT-6 Astra effort low (small/doc PRs).

1. Read AGENTS.md, then `gh pr view <N> --comments` and `gh api repos/Nextoz/vault-companion/pulls/<N>/comments`.
2. For **each** CodeRabbit comment, decide:
   - **fix**: make the change on the PR's head branch. If it touches behaviour, add or adjust a test that fails without
     the fix. Respect the specs (`docs/vault-contract.md`, `docs/commands.md`, ADRs); a comment that contradicts a spec is
     not a fix.
   - **reject**: reply on the comment thread with a one-paragraph reason (spec citation or evidence).
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` (plus `pnpm --filter @vault-companion/web e2e` if `apps/web` changed).
   All must pass.
4. Commit and push the head branch. Post one PR comment:
   `CodeRabbit follow-up: <k> fixed, <m> rejected (reasons in threads). Checks: <results>.`
5. Do not merge, approve, close or open PRs. Do not spawn agents. The Lead merges.
