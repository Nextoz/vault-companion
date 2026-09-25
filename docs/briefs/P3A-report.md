# P3-A report — Cloudflare deploy scaffolding

Branch `agent/deploy-scaffold`. Nothing was deployed; no account, login or external service was used.

## Files

Added:
- `apps/worker/wrangler.jsonc` — entry `src/index.ts`, `compatibility_date` 2026-09-20, `send_metrics: false`,
  static assets from `../web/dist` with `run_worker_first: ["/api/*"]` and SPA fallback; vars `AUTH_MODE="access"`,
  `VAULT_BRANCH="main"`, `USER_TIME_ZONE="Europe/Copenhagen"` (the domain default); the other nine `REQUIRED` names
  in `secrets.required` plus a comment with each `wrangler secret put` command. No `account_id`, no routes.
- `apps/worker/src/config.test.ts` — loads `wrangler.jsonc` (string-aware comment/trailing-comma strip) and asserts:
  every `REQUIRED` name is a var or a required secret; `AUTH_MODE` is `"access"`; no secret also has a committed var;
  committed vars pass `configProblems` validation; `/api/*` runs the Worker over `../web/dist` assets.
  `REQUIRED` is private to `index.ts`, so the test derives it from `configProblems({ AUTH_MODE: 'access' })`
  (`missing X` lines) — `index.ts` is unchanged.
- `apps/worker/src/raw.d.ts` — ambient type for Vite's `?raw` import, so the test needs no Node types in the Worker
  project (its tsconfig keeps `types: []`).
- `docs/deploy.md` — G2 runbook (plan choice, GitHub App, install, Access, secrets, dry run, deploy, smoke check).

Changed:
- `apps/worker/package.json` — `build` script (web build + `wrangler deploy --dry-run --outdir dist`); devDependency
  `wrangler` pinned `4.138.0` (what pnpm resolved; 4.140.0 is on npm but newer than the resolver allowed).
- `package.json` — `deploy:dry` → `pnpm --filter @vault-companion/worker build`.
- `pnpm-lock.yaml` — wrangler install.
- `pnpm-workspace.yaml` — **outside the brief's "May change" list, but required by the install:** pnpm 12 wrote an
  `allowBuilds` block with placeholders for `esbuild` and `workerd` install scripts. Set both to `false`: the dry run
  and `wrangler dev` work without them (platform binaries come from optional dependencies). Lead: accept or
  revert with an alternative.

Not changed: `apps/web/vite.config.ts` (root-relative paths already right), any `src` logic, other docs.

## Verification

- `pnpm check`: green — lint, typecheck, 29 files / 459 tests.
- Guard proof: temporarily appended `'VAULT_BRANCH_X'` to `REQUIRED` in `index.ts` → `config.test.ts` failed with
  `undeclared = ["VAULT_BRANCH_X"]`; reverted (`git diff` of `index.ts` empty).
- `pnpm deploy:dry`: succeeds, **no `nodejs_compat` needed**. Worker bundle `dist/index.js` **975,340 bytes
  (171,439 gzip)** (+ source map 1.77 MB, not uploaded as code). Wrangler: "Read 11 files from the assets directory",
  Total Upload 952.48 KiB / gzip 167.49 KiB. The asset manifest (debug log) lists `/index.html`, `/sw.js`,
  `/manifest.webmanifest`, `/assets/index-*.{js,css}`, `/icons/*`.
- Local `wrangler dev` (no account, workerd locally): `/` 200 text/html; `/sw.js` 200 text/javascript (root scope);
  `/manifest.webmanifest` 200 application/manifest+json; `/icons/icon-192.png` 200; deep link with
  `Sec-Fetch-Mode: navigate` → index.html; `/api/session` → **503 `Service not configured`, `Cache-Control: no-store`**
  from the Worker (proves `/api/*` reaches Hono and the guard refuses without secrets).
- Web e2e: **WebKit is not installed in this container** (`/opt/pw-browsers` has Chromium only), so
  `pnpm --filter @vault-companion/web e2e` hangs here. Ran the same 8 specs with a throwaway config (not committed)
  swapping the project to Chromium on the iPhone 15 profile: **8/8 passed**. WebKit run still owed on the owner/Lead
  machine.

## Subrequest analysis

Detail in `docs/deploy.md` §0. Worst case `UndoCompleteTask`: 75 subrequests per attempt (three 20-page compare
scans — own dedupe, target lookup, "already undone" — plus reads and the 6-call Git write), × 5 attempts + token +
JWKS = **377**. Shallow case: 92 for five attempts, 20 for one. Free (50) is insufficient; **Workers Paid (1,000)
suffices** with ~2.6× headroom. `docs/plan.md` "Unresolved issues" says two paged dedupes per attempt; the code has
three — Lead may want to update that line (plan.md was outside this brief).

## Open points / unverifiable without an account

1. Real deploy, secrets, Access JWT verification against a live team domain, GitHub App token exchange.
2. Plan limits quoted from memory (Free 50 / Paid 1,000) — owner re-checks Cloudflare's current limits page at G2.
3. **Security headers on static assets:** with `run_worker_first: ["/api/*"]`, HTML/JS are served by the asset
   layer, so `app.ts`'s `SECURITY_HEADERS` (HSTS, `frame-ancestors 'none'`, nosniff, COOP…) are **not** on the PWA
   responses; only the `<meta>` CSP from `vite.config.ts` applies, and `frame-ancestors` cannot be set by meta.
   Suggested follow-up: `apps/web/public/_headers` (Workers assets honour it) — outside this brief's scope.
4. Access on `workers.dev` vs a custom domain is the owner's choice at G2; `APP_ORIGIN` must match exactly.
5. **Push:** this session has no `origin` remote (bundle upload); `git push` fails with
   `fatal: 'origin' does not appear to be a git repository`. Commits are local only until the session is given
   push access.
