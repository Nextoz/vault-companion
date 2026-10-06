# ADR-0058 — GitHub Actions owns production deploys

**Status:** accepted (Pro, 2026-10-06). Consequential: this changes who may push production and adds a Cloudflare
credential with edit rights.

## Context

Production deploys were manual `wrangler deploy`/`wrangler versions` runs from the owner's machine. That made deploys
unreviewable, depended on one person having edit credentials, and caused the 2026-10-04 Morning Brief miss:
`wrangler versions deploy` promotes traffic but does **not** apply cron triggers, so the brief's new crons were not
installed even though its code was live. A merge to `main` that passes CI should deploy automatically after one owner
approval, verify the production origin anonymously, record the versions, and roll back if verification fails.

## Decision

- **`wrangler deploy`, not `versions deploy`.** The deploy job runs `wrangler deploy` because it atomically uploads,
  promotes to 100 %, applies domains, and applies cron triggers in one command. `wrangler versions upload` +
  `wrangler versions deploy` remains only as a documented manual fallback, followed by `wrangler triggers deploy`.
- **Approval gate.** `deploy` uses the GitHub `production` environment with one owner as a required reviewer. This is
  the default now. Removing that reviewer makes merges deploy automatically; do not enable that until two approved
  deploys have been watched end-to-end. Two merges queue under `deploy-production` with `cancel-in-progress: false`.
- **Verification and rollback.** `tools/smoke-test.mjs` requests `/` and `/api/session` anonymously; both must stop
  at Cloudflare Access (302/403, never 200), each fetch is retried up to three times, and the new version must be at
  100 %. Any failure runs `wrangler rollback <previous-version-id> --yes`; a failing rollback or a missing previous
  version is loud and leaves the run red. If the Cloudflare status API cannot be read, the run is red but rollback is
  not attempted because traffic state is unknown.
- **Least-privilege CI token.** The Cloudflare token has exactly `Account → Workers Scripts → Edit`, scoped to this
  account. It lives only in the `production` environment secrets, with `CLOUDFLARE_ACCOUNT_ID` and `PRODUCTION_HOST`.
  Worker runtime secrets stay in Cloudflare and are never copied into CI.
- **No manual rights needed.** The owner keeps bootstrap/emergency access, but the Lead no longer needs production
  deploy rights; the normal deploy path is the GitHub Actions job.

## Branch protection

The repository is public, so free GitHub plans normally allow a `main` ruleset. The exact ruleset fields for this
repository's plan are to verify by owner while creating it; at minimum it must require a pull request before merging
and the `ci` status check.

## Consequences

Deploys are observable and approval-gated. The new Cloudflare edit token is a high-value secret and must remain only
in the `production` environment. The CI summary records new version, previous version, and the exact rollback command,
and no token value is printed. Docs-only merges still deploy, which is functionally idempotent because the Worker code
and config are unchanged.
