# Handoff — P3-A deploy scaffold

Branch `agent/deploy-scaffold`. Full report: `docs/briefs/P3A-report.md`. Runbook: `docs/deploy.md`.

## Completed

- `apps/worker/wrangler.jsonc`: one Worker; web build as static assets, `run_worker_first: ["/api/*"]`, SPA fallback;
  `compatibility_date` 2026-09-20, no `nodejs_compat`, `send_metrics: false`, no `account_id`.
- Vars/secrets (decision 2): committed vars are only `AUTH_MODE="access"`, `VAULT_BRANCH="main"`,
  `USER_TIME_ZONE` placeholder. All nine identifying settings (incl. `GITHUB_APP_PRIVATE_KEY`) are
  `secrets.required` + `wrangler secret put` comments.
- Static security headers (decision 3): `apps/web/public/_headers` gives `/*` exactly the Worker's
  `SECURITY_HEADERS` (now exported from `app.ts`, no behaviour change).
- `allowBuilds` (decision 1): explicit `esbuild: true`, `workerd: true` only. Why: both are wrangler's
  native-binary packages; their `postinstall` verifies/selects the platform binary (downloads it if the optional
  platform package is missing). No other package has build scripts approved.
- Scripts: worker `build` (web build + `wrangler deploy --dry-run --outdir dist`), root `deploy:dry`;
  `wrangler` pinned `4.138.0` (worker devDependency only).
- Tests: `apps/worker/src/config.test.ts` (REQUIRED ↔ config, vars allowlist, AUTH_MODE, assets routing),
  `apps/worker/src/headers.test.ts` (`_headers` ≡ `SECURITY_HEADERS`), `apps/web/test/dist.test.ts` (real Vite build
  contains `_headers`; `tsconfig.tools.json` now typechecks `test/`).
- `docs/deploy.md`: G2 steps, plan sizing, header check on the deployed app.

## Important discoveries

- Static assets bypass the Worker, so `app.ts` headers never reached the PWA — hence `_headers`.
- Undo does **three** paged compare scans per attempt (own dedupe, target, "already undone"), not two as
  `docs/plan.md` says. Worst case 377 subrequests (5 attempts × 75 + token + JWKS); shallow 5-attempt case 92.
  Free (50) insufficient; **Workers Paid (1,000)** suffices.
- `Cache-Control: no-store` copied exactly from the constant: hashed assets are not HTTP-cached; offline still works
  via the SW precache (Cache Storage ignores the header).
- Container has Chromium only: the WebKit e2e project cannot run here.
- This session has no `origin` remote (see Commit).

## Recommend

- Lead: fix the "two paged dedupes" line in `docs/plan.md` to three.
- Run `pnpm --filter @vault-companion/web e2e` (WebKit) on a machine with WebKit before merge.
- Owner re-checks Cloudflare's current subrequest limits at G2; choose Paid.
- Consider a longer `Cache-Control` for `/assets/*` later (would need the constant/test to allow a per-path rule).

## Verification

- `pnpm check`: green, 31 files / 462 tests.
- Break-proofs: extra `REQUIRED` entry → `config.test.ts` fails; `frame-ancestors` removed from `_headers` →
  `headers.test.ts` fails; `_headers` removed → `dist.test.ts` fails. All reverted.
- `pnpm deploy:dry`: OK; 12 asset files read (incl. `_headers`); bundle 975,340 B (171,439 gzip).
- Local `wrangler dev`: `/`, `/sw.js`, `/manifest.webmanifest`, icons 200 with correct types; `/` and JS carry all
  `_headers` headers; `/_headers` returns `index.html`; `/api/session` → Worker 503 (unconfigured).
- Web e2e: 8/8 on Chromium via a throwaway config (not committed); WebKit not run.

## Commit

See `git log agent/deploy-scaffold`; the Lead reply carries the final SHA. Push status is in the reply.
