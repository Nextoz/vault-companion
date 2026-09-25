# Deploy runbook (human gate G2)

The owner's steps to take Vault Companion live on Cloudflare. Everything here is done by the owner on their own
machine; agents never log in, deploy or touch an account. Config: `apps/worker/wrangler.jsonc`. Placeholders below
(`<team>`, `<host>`, `<owner>`, `<vault-repo>`) are never committed with real values — the repository is public.

One Worker serves both the PWA (`apps/web/dist` via Workers static assets) and the API: `/api/*` always runs the
Worker; everything else is a static file. One origin is required by the origin/CSRF checks in `apps/worker/src/app.ts`.

## 0. Choose the plan (subrequest limit)

Each Worker invocation may make a limited number of subrequests (outbound `fetch`): **Free 50, Paid 1,000**
(re-check the current Cloudflare limits page when you do this step). Every GitHub API call is one subrequest.

Worst case is an `UndoCompleteTask` whose five attempts all lose the ref race and whose dedupe windows are each at
the 20-page compare limit (`maxComparePages`, 250 commits/page) in `packages/github/src/contents-store.ts`:

| Per attempt | Subrequests |
|---|---|
| `head()` | 1 |
| own dedupe `findOperation` (not found) | 20 |
| Undo target `findOperation` (found on page 20) + commit detail | 21 |
| "already undone?" `findOperation` | 20 |
| `replayOnParent` (parent, read at parent, read at commit) | 3 |
| read TODO at X, at completion, parent + read at parent | 4 |
| `writeFile` (tree, base commit, blob, tree, commit, ref PATCH) | 6 |
| **Attempt total** | **75** |

5 attempts = 375, plus 1 installation-token fetch and 1 Access JWKS fetch (both cached per isolate) = **377**.
A shallow Undo (1 compare page each) is 18 per attempt, 92 for five attempts — already over 50.

**Use Workers Paid.** 377 fits under 1,000 with margin; Free covers only a single happy-path attempt.
(`docs/plan.md` counted two paged dedupes per Undo attempt; there are three — own operation, target, prior undo.)

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- Name: any; Homepage URL: any placeholder.
- **Webhook: uncheck Active** (no webhooks).
- Repository permissions: **Contents: Read and write**, **Metadata: Read-only**. Nothing else; no account permissions.
- "Where can this GitHub App be installed?": Only on this account.
- Create, then note the **App ID**, and generate a **private key** (downloads a PKCS#1 `.pem`). Convert it to the
  PKCS#8 form the Worker expects, then keep both files outside any repository:

  ```sh
  openssl pkcs8 -topk8 -nocrypt -in <downloaded>.pem -out app-pkcs8.pem
  ```

## 2. Install it on the vault repository only

App page → Install App → your account → **Only select repositories** → the vault repository. After installing, the
URL is `https://github.com/settings/installations/<id>`: `<id>` is the **installation ID**.

## 3. Cloudflare Access application and policy

Zero Trust → Access → Applications → Add → Self-hosted.

- Domain: the Worker's hostname (custom domain or `vault-companion.<subdomain>.workers.dev`). Cover the whole host,
  not just `/api/*`: the PWA shell is private too.
- Policy: Action **Allow**, Include → **Emails** → the owner's address(es). No other rules.
- Save and copy the **Application Audience (AUD) tag**. The team domain is `https://<team>.cloudflareaccess.com`.

## 4. Secrets

From `apps/worker`, logged in with `pnpm exec wrangler login` (owner only) and `CLOUDFLARE_ACCOUNT_ID` set in your
shell. Each command prompts for the value; nothing is written to disk or the repo.

```sh
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN       # https://<team>.cloudflareaccess.com
pnpm exec wrangler secret put ACCESS_AUD               # AUD tag from step 3
pnpm exec wrangler secret put ALLOWED_EMAILS           # same address(es) as the Access policy, comma-separated
pnpm exec wrangler secret put APP_ORIGIN               # https://<host>, no trailing slash
pnpm exec wrangler secret put GITHUB_APP_ID            # step 1
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
pnpm exec wrangler secret put GITHUB_INSTALLATION_ID   # step 2
pnpm exec wrangler secret put VAULT_OWNER              # <owner>
pnpm exec wrangler secret put VAULT_REPO               # <vault-repo>
```

The first `secret put` creates the Worker if it does not exist yet. The repository is public, so **every identifying
setting is a secret** — the nine above, not only the private key. Only three non-identifying vars are committed in
`wrangler.jsonc`: `AUTH_MODE="access"`, `VAULT_BRANCH`, and a placeholder `USER_TIME_ZONE` (the domain default).
Never move a secret into `vars`; `apps/worker/src/config.test.ts` fails if `vars` holds anything else. To use your own
branch or zone without committing it, override at deploy time
(`wrangler deploy --var USER_TIME_ZONE:<zone>`). Any missing or invalid setting makes `/api/*` answer `503 Service not configured` (`configProblems`).

## 5. Dry run

From the repository root: `pnpm install && pnpm check && pnpm deploy:dry`. Expect the web build, "Read 12 files
from the assets directory" (count varies with the build) and `--dry-run: exiting now.`

## 6. First deploy

```sh
cd apps/worker && pnpm exec wrangler deploy
```

(`pnpm deploy:dry` already built `apps/web/dist`; rebuild it with `pnpm --filter @vault-companion/web build` if the
web app changed since.)

## 7. Smoke check

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
