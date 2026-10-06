# Deploy runbook (CI/CD plus owner bootstrap)

The owner bootstraps Cloudflare and GitHub once (this page), then **merges to `main` are the only production deploy
path**. GitHub Actions runs CI, deploys with `wrangler deploy`, smoke-tests the public origin anonymously, and rolls
back to the previous version if the smoke test fails. Nobody runs `wrangler deploy` by hand as the normal path, and
the Lead does not need production deploy rights. The sections after the bootstrap are the one-time Cloudflare setup;
the manual fallback at the end exists for emergencies and the first-ever deploy.

Config: `apps/worker/wrangler.jsonc`. Placeholders below (`<team>`, `<host>`, `<owner>`, `<vault-repo>`,
`<path-outside-repos>`) are never committed with real values — the repository is public.

One Worker serves both the PWA (`apps/web/dist` via Workers static assets) and the API: `/api/*` always runs the
Worker; everything else is a static file. One origin is required by the origin/CSRF checks in `apps/worker/src/app.ts`.
That origin is the owner's **custom domain behind Cloudflare Access, and nothing else**: `wrangler.jsonc` sets
`workers_dev: false` and `preview_urls: false` (asserted by `apps/worker/src/config.test.ts`), so no `*.workers.dev`
or per-version preview hostname exists to bypass Access.

## CI/CD flow (ADR-0058)

1. A pull request runs `check` exactly as before. `deploy` never runs on `pull_request` or `workflow_dispatch`; only
   a push to `main` starts it, and it waits for the full PR checks (`needs: [check]`).
2. `deploy` uses the `production` GitHub environment, whose required reviewers make one owner approval mandatory
   before any merge deploy. The job concurrency group `deploy-production` has `cancel-in-progress: false`, so two
   merges in a row queue instead of overlapping.
3. The job installs with `pnpm install --frozen-lockfile`, builds the web app, tags the Worker version with the commit
   SHA, and from `apps/worker` runs `pnpm exec wrangler deploy --domain "$PRODUCTION_HOST" --tag "$GITHUB_SHA"`.
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist only as `production` environment secrets.
4. `tools/smoke-test.mjs` requests `/` and `/api/session` anonymously. Both must be stopped by Access (302/403,
   never 200) and the new version must carry 100% traffic. Each fetch is retried up to three times before the smoke
   test is declared failed.
5. On smoke failure the job runs `wrangler rollback <previous-version-id>` and exits red. The step summary always
   shows the new version id, previous version id, and the exact rollback command; token or secret values are never
   printed. If the status API is down the run is red and rollback is deliberately not attempted.
6. Docs-only merges still run the job; deploying the unchanged Worker is functionally idempotent and the smoke test
   still verifies production.

### Owner one-time setup

1. Create a Cloudflare API token: My Profile → API Tokens → Create Token → **Create Custom Token**.
2. Permissions: `Account` → `Workers Scripts` → `Edit`. Account Resources: include **only this account**; Zone
   Resources: leave as-is (no zone permission is granted). Continue to summary → Create Token, and copy the value.
3. In GitHub, open the repository → Settings → Environments → **New environment**, name it `production`.
4. Add three environment secrets: `CLOUDFLARE_API_TOKEN` (the token from step 2), `CLOUDFLARE_ACCOUNT_ID` (Cloudflare
   dashboard → Workers & Pages → Account ID), and `PRODUCTION_HOST` (the custom domain hostname only, e.g.
   `vc.example.com`). The Worker's nine runtime secrets stay in Cloudflare and are never copied here.
5. On the same environment page, tick **Required reviewers** and add one owner. Until two approved deploys have been
   watched, leave the reviewer in place; removing it would make deploys automatic.
6. Under Settings → Rules → Rulesets, add a `main` ruleset that requires a pull request before merging and requires
   the `ci` status check. The exact fields available on this public free plan are to verify by owner while creating
   the ruleset.

## 0. Choose the plan (subrequests and CPU)

Limits per Worker invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/); re-check):
**Free: 50 subrequests, 10 ms CPU. Paid: 10,000 subrequests, 30 s CPU (default).** Every GitHub call is a subrequest.

Every command is bounded (ADR-0013 Undo, review O1 reads, [ADR-0015](decisions/0015-bounded-write-budget.md) writes):
one compare page per dedupe, at most 3 attempts. Measured worst cases (full 250-commit page, the head moved on every
attempt, cold installation token, cold Access JWKS), real adapter with a counting `fetch`:

| Request | Subrequests, worst case | CPU (warm, fake network; review O2) |
|---|---|---|
| `CompleteTask` / `CaptureTask` / `CaptureNote` | 8 per attempt, ≤ 3 attempts: **26** | Complete 8.5 ms on a 300-task list, 29.7 ms on 1,500 |
| `UndoCompleteTask` (ADR-0013) | ≤ 10 per attempt, ≤ 3 attempts: **32** | — |
| `GET /api/tasks` (review O1) | ≤ 4: **6** | 3.4–12.5 ms before network parsing |

| Research explainer cron (ADR-0029) | one counted budget of **45** for GitHub + Gemini (`SUBREQUEST_BUDGET`); model calls stop while the commit is still paid for, and after 10 min wall time (Cron limit 15 min); the rest waits as pending notes for the next run | fetch-bound (the paper is read by the model by URL, never parsed in the Worker) |

**The Free plan suffices for subrequests.**

**Owner decision (2026-09-26): Free.** The owner's list is ~16 KB / 39 tasks (est. 4–5 ms). After the first deploy,
measure real CPU per request with `wrangler tail` (read-only requests first) before the canary; if a request nears 10 ms,
optimise it rather than change plan. Failures are safe either way
(head-CAS; a killed request is an unknown outcome, deduplicated on retry) but the phone would see repeated 503s.

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: any; Homepage URL: any placeholder.
- **Webhook: uncheck Active** (no webhooks).
- Repository permissions: **Contents: Read and write**, **Metadata: Read-only**. Nothing else; no account permissions.
- "Where can this GitHub App be installed?": Only on this account.
- Create, then note the **App ID**, and generate a **private key** (downloads a PKCS#1 `.pem`). Convert it to the
  PKCS#8 form the Worker expects. Keep both files in a directory **outside every Git repository**:

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in "<path-outside-repos>/<downloaded>.pem" -out "<path-outside-repos>/app-pkcs8.pem"
  ```

## 2. Install it on the vault repository only

App page → Install App → your account → **Only select repositories** → the vault repository. After installing, the
URL is `https://github.com/settings/installations/<id>`: `<id>` is the **installation ID**.

## 2b. History protection for the vault `main`

Rulesets and branch protection on a **private** repository need GitHub Pro (verified 2026-09-26: API 403). With the
free plan the guarantee comes from the writers instead: the Worker's ref update is `force: false`
(`packages/github/src/contents-store.ts`), and the desktop sync never force-pushes. Rule for humans: repair mistakes with
`git revert`, never a reset or force-push. If history is ever rewritten anyway, the app offers "Reset saved-actions
history on this device" after repeated stale reads (review O6), which clears receipts and the watermark, never pending
actions. With GitHub Pro, add a `main` ruleset blocking force pushes and deletion.

## 3. Cloudflare Access application and policy

The custom domain `<host>` must be on a zone in your Cloudflare account. Zero Trust → Access → Applications → Add →
Self-hosted.

- Domain: `<host>`, **whole host, no path** — it must cover both the app shell and `/api/*`.
- Policy: Action **Allow**, Include → **Emails** → the owner's address(es). No other rules.
- Save and copy the **Application Audience (AUD) tag**. The team domain is `https://<team>.cloudflareaccess.com`.

Create Access **before** the first deploy, so `<host>` is never reachable unprotected.

## 4. Dry run

From the repository root: `pnpm install && pnpm check && pnpm deploy:dry`. Expect the web build, "Read 12 files
from the assets directory" (count varies with the build) and `--dry-run: exiting now.` Nothing is uploaded.

## 5. Log in

```sh
cd apps/worker
pnpm exec wrangler login --use-keyring
```

`--use-keyring` keeps the OAuth token in the OS keychain; without it wrangler stores it in a **plaintext TOML file**
in your home directory. Set `CLOUDFLARE_ACCOUNT_ID` in your shell (not in the repo).

## 6. Secrets file (outside every repository)

The first deploy uploads the Worker **and all nine secrets in one version**, so no live version ever runs without
them. Write this JSON to `<path-outside-repos>/secrets.json` — an absolute path **outside any Git repository** —
replacing each placeholder (the keys are checked against `wrangler.jsonc` by `apps/worker/src/config.test.ts`):

```json
{
  "ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
  "ACCESS_AUD": "<AUD tag from step 3>",
  "ALLOWED_EMAILS": "<same address(es) as the Access policy, comma-separated>",
  "APP_ORIGIN": "https://<host>",
  "GITHUB_APP_ID": "<App ID from step 1>",
  "GITHUB_APP_PRIVATE_KEY": "<set by the command below>",
  "GITHUB_INSTALLATION_ID": "<installation ID from step 2>",
  "VAULT_OWNER": "<owner>",
  "VAULT_REPO": "<vault-repo>"
}
```

Then put the multi-line PEM into it with correct JSON escaping (Node is already required by the repo):

```sh
node -e "const fs=require('fs');const [f,k]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(f,'utf8'));s.GITHUB_APP_PRIVATE_KEY=fs.readFileSync(k,'utf8');fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n')" "<path-outside-repos>/secrets.json" "<path-outside-repos>/app-pkcs8.pem"
```

The repository is public, so **every identifying setting is a secret** — the nine above, not only the private key.
Only three non-identifying vars are committed in `wrangler.jsonc`, with fixed values: `AUTH_MODE="access"`,
`VAULT_BRANCH="main"` (the vault branch), and `USER_TIME_ZONE="Europe/Copenhagen"` (durable dates are Copenhagen
dates, `docs/vault-contract.md`). Do not override them at deploy time, and never move a secret into `vars`;
`config.test.ts` fails if `vars` differs.

## 7. First deploy

Still in `apps/worker`:

```sh
pnpm exec wrangler deploy --domain "<host>" --secrets-file "<path-outside-repos>/secrets.json"
```

Replace both quoted placeholders with real values before running (e.g. `--domain "vc.example.com"`); unquoted `<host>`
would be read by the shell as a redirection.

This uploads one version with the committed config (`workers_dev`/`preview_urls` off), all nine secrets, and
`<host>` as its custom domain. Pass `--domain "<host>"` on **every** later deploy too, so the domain stays out of the
repo; later deploys need no `--secrets-file` (secrets carry over between versions). (`pnpm deploy:dry` already built
`apps/web/dist`; rebuild it with `pnpm --filter @vault-companion/web build` if the web app changed since.)

If a secret is missing or invalid, **every `/api/*` request answers `503 Service not configured`** (`configProblems`
in `apps/worker/src/index.ts`); the static shell is still served, behind Access.

Afterwards **delete `secrets.json`**, or keep it only outside every repository (e.g. in your password manager). Store
or delete the `.pem` files the same way.

### Research explainer (ADR-0029): cron and Gemini key

`wrangler.jsonc` schedules the job at `30 4 * * *` and `30 6 * * *` (UTC; daily run + catch-up). It needs one more
secret, `GEMINI_API_KEY`, which is deliberately **not** in `secrets.required` or `secrets.json`: the API keeps serving
without it, and the cron then logs `gemini-key-missing` and writes nothing. Add it after step 7:

```sh
pnpm exec wrangler secret put GEMINI_API_KEY
```

(It prompts for the value; never put it in a file in a repository.) Check a run with `pnpm exec wrangler tail` around
04:30 UTC: one `cron:research-explainer` record per run, with only status, operation ID and commit SHA. A run can be
triggered locally with `wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=30+4+*+*+*"`
(against a sandbox vault only).

### Rotating a secret later

Once the Worker exists, change one value with `pnpm exec wrangler secret put <NAME>` (it prompts for the value; for
the key: `pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < "<path-outside-repos>/app-pkcs8.pem"`). Each
`secret put` immediately deploys a new live version. Never run `secret put` before step 7: on a Worker that does not
exist yet it creates one without this config.

## 8. Verify the hostnames

Cloudflare dashboard → Workers & Pages → `vault-companion` → Settings → **Domains & Routes**: the only entry is the
custom domain `<host>`. `workers.dev` is **disabled**, **Preview URLs** are **disabled**, and there are no routes.
Then Zero Trust → Access → Applications: the application's domain is exactly `<host>` with no path, so it covers the
app shell and `/api/*`. Anything else enabled ⇒ disable it before continuing.

## 9. Smoke check

1. Private window → `https://<host>/` → Access login → the app loads.
2. `https://<host>/api/session` → `200` with `{"accountKey":"…"}`. `401` = Access JWT rejected (check
   `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN`/`ALLOWED_EMAILS`); `503` = a secret is missing or invalid.
3. `curl -i https://<host>/api/session` without a session → blocked by Access (redirect/403), never `200`.
4. Security headers on static pages (served by the asset layer from `apps/web/public/_headers`, not by the Worker):
   in the browser's DevTools → Network, select the document request for `/` and one `/assets/*.js` — both must carry
   `Content-Security-Policy` (with `frame-ancestors 'none'`), `Strict-Transport-Security`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`,
   `Cross-Origin-Opener-Policy` and `Cache-Control: no-store`, matching an `/api/session` response. (A plain `curl`
   is stopped by Access; with a service token or the `CF_Authorization` cookie, `curl -sI https://<host>/` shows
   the same.) `https://<host>/_headers` must return the app's HTML, never the rules file.
5. The task list loads (read path through the GitHub App). Do **not** complete a task yet: the first live write is
   gate G3.

## 10. Manual fallback (emergencies only)

If GitHub Actions is unavailable and a deploy is urgent, the owner can reproduce the CI path from a clean checkout.
This is not the normal flow and is done only when the pipeline itself is broken.

```sh
pnpm install --frozen-lockfile
pnpm --filter @vault-companion/web build
export CLOUDFLARE_API_TOKEN="<token>" CLOUDFLARE_ACCOUNT_ID="<account-id>"
pnpm --filter @vault-companion/worker exec wrangler versions upload --tag "$(git rev-parse HEAD)"
pnpm --filter @vault-companion/worker exec wrangler versions deploy <uploaded-version-id>@100 --yes
pnpm --filter @vault-companion/worker exec wrangler triggers deploy
```

The three Cloudflare commands match the historical `versions` workflow: upload first, then deploy that version, then
apply cron triggers. Do not skip the final `triggers deploy`; `wrangler versions deploy` alone does not apply crons
(the 4 Oct Morning Brief miss), while the normal CI path uses `wrangler deploy`, which does apply them.
