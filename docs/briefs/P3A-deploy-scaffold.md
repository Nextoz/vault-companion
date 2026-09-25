# Brief P3-A — Cloudflare deploy scaffolding (no credentials, no deploy)

Type: **implementation** (bounded). Branch `agent/deploy-scaffold`. Runs as a **Claude Code Cloud** task (Linux).

## Objective

Make Phase 3 a matter of the owner filling in credentials (human gate G2), not writing code. Nothing is deployed and
no account, secret or external service is touched.

1. **Worker config:** `apps/worker/wrangler.jsonc` for the existing entry `apps/worker/src/index.ts`
   (read it first: `Env`, `REQUIRED`, `configProblems`). Non-secret vars as placeholders (`AUTH_MODE: "access"`,
   `VAULT_BRANCH`, `USER_TIME_ZONE`); every secret listed in a comment with its `wrangler secret put` name, never a
   value. Pin `compatibility_date`; add `nodejs_compat` only if the build proves it is needed.
2. **PWA hosting:** serve `apps/web` build output from the same Worker via Workers static assets (`assets` binding),
   so the app and `/api/*` share one origin (the origin/CSRF checks in `apps/worker/src/app.ts` assume this).
   `/api/*` must reach the Hono app; everything else is assets. Check that the service worker scope and
   `manifest.webmanifest` still work at the root.
3. **Scripts:** `pnpm --filter @vault-companion/worker build` (web build + `wrangler deploy --dry-run --outdir dist`)
   and a root `pnpm deploy:dry`. Add `wrangler` as a pinned devDependency of the worker only.
4. **Test:** one Vitest test that loads `wrangler.jsonc` (strip comments) and asserts every name in `REQUIRED` is
   either a declared var or listed as a secret, and `AUTH_MODE` is `"access"`. It must fail if a `REQUIRED` entry is
   added without config (break it once to prove it, and say so in the report).
5. **Runbook:** `docs/deploy.md` — the owner's G2 steps in order: create the GitHub App (permissions: Contents
   read/write on the vault repo only, Metadata read; no webhooks), install it on the vault repo only, Cloudflare
   Access application + policy (allowed emails), secrets via `wrangler secret put`, `pnpm deploy:dry`, first real
   deploy, smoke check (`/api/session` behind Access). Note the Workers subrequest limit per plan against the
   worst case in `docs/plan.md` "Unresolved issues" (Undo dedupe paging × 5 attempts) and state which plan suffices.

## May change

`apps/worker/**` (config, scripts, the new test; not `src/app.ts`, `src/auth.ts`, `src/index.ts` logic),
`apps/web/vite.config.ts` only if asset paths require it, root `package.json` (`scripts`, and the lockfile via install),
`docs/deploy.md`, `docs/briefs/P3A-report.md`.

## Must not change

Domain, kernel, stores, contracts, security checks, any other doc. No `wrangler login`, no deploy, no account calls.
No real account IDs, domains, emails or secrets anywhere — placeholders only (the repo is public).

## Verify

`pnpm check` green; `pnpm deploy:dry` succeeds and the bundle contains the assets manifest; web e2e still green
(`pnpm --filter @vault-companion/web e2e`).

## Report

`docs/briefs/P3A-report.md`: files added, bundle size from the dry run, the subrequest analysis, anything unverifiable
without an account. **Push early:** commit the report stub and push `agent/deploy-scaffold` within your first few
minutes, then push again when done. Print at the end: `P3A DONE <commit-sha> — docs/briefs/P3A-report.md`.
