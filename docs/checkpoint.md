# Checkpoint — 2026-09-26 (read-only deploy next)

**HEAD:** `main`; PRs #1–#14 merged. Blockers and owners: `docs/plan.md`.

- PR #15 read budget (O1/O5/O6): verified locally; focused review running; merge when CI + review pass.
- `agent/free-budget` (A1/A4, ADR-0015): Cloud P4-B session `session_01TLT6gLxkoKtDHSy8CcCpmb`.
- Deploy: secrets file complete and validated (outside the repo); GitHub App verified; Access for `app.karpov.dk` done.
  Next: owner `wrangler login --use-keyring`; Lead runs the dry run and the first (read-only) deploy per `docs/deploy.md`,
  then verifies Access, `/api/session`, live reads, headers, CPU (`wrangler tail`) — and stops before G3.
- Reviews: `docs/reviews/phase-2-review-{opus,astra}.md`. Desktop sync + snapshots healthy.
