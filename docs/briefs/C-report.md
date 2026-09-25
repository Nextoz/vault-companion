# Brief C — report (CI pipeline)

Branch `agent/ci`. Ran as a Claude Code Cloud task (Linux sandbox).

## Added

- `.github/workflows/ci.yml`: runs on `push` and `pull_request`, with workflow-level `permissions: contents: read`
  only. Matrix `ubuntu-latest` + `windows-latest` (`fail-fast: false`). Steps in `ci:local` order: checkout
  (`fetch-depth: 0` for gitleaks, `persist-credentials: false`), pnpm (no `version` input, so the action reads
  `packageManager` = `pnpm@12.6.0` from root `package.json`), Node 24 with `cache: pnpm`,
  `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, Playwright WebKit install
  (`playwright install --with-deps webkit`, ubuntu only), `pnpm --filter @vault-companion/web e2e` (ubuntu only),
  `pnpm audit --prod --audit-level high`, gitleaks (ubuntu only). Per-ref `concurrency` cancels superseded runs.
- Root `package.json` script `ci:local`:
  `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @vault-companion/web e2e && pnpm audit --prod --audit-level high`.

## Action pins (threat model T15)

`gh` is not installed in the sandbox and the GitHub REST API is blocked for this session, so every SHA was resolved
with `git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<tag> refs/tags/<tag>^{}` against the real
upstream. Annotated tags were peeled to the commit (`^{}`); the others are lightweight tags pointing at the commit.
The latest release tag was chosen from `git ls-remote --tags`.

| Action | Tag | Commit SHA | Tag kind |
|---|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | lightweight |
| `pnpm/action-setup` | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` | annotated (tag obj `d9184bf1…`, peeled) |
| `actions/setup-node` | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` | lightweight |
| `gitleaks/gitleaks-action` | v3.0.0 | `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` | lightweight |

The `action.yml` of each pinned SHA was fetched from `raw.githubusercontent.com` to confirm the inputs used
(all four run on `node24`).

## Git identity (objective 4)

No CI step was added. The tests set the identity themselves: `packages/github/src/git-fixture.ts` sets
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the env of every fixture `git` call, and `local-git-store.ts` sets them per
commit from the caller's identity. Checked by running `packages/github` tests with `HOME` pointed at an empty
directory, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`: 3 files, 54 tests passed.

## Local run (Linux, Node v24.21.0, pnpm 12.6.0)

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm lint` | ok |
| `pnpm typecheck` | ok |
| `pnpm test` | 27 files, 443 tests passed |
| web e2e | **not run: WebKit is not available.** The sandbox image ships Chromium only, and `playwright install webkit` gets a 403 from the sandbox network policy (`cdn.playwright.dev` and `playwright.download.prss.microsoft.com` are blocked). All 8 specs fail at `browserType.launch: Executable doesn't exist …/webkit-2359`. This is the environment, not the code. |
| `pnpm audit --prod --audit-level high` | "No known vulnerabilities found" |

So `pnpm ci:local` is **not fully green here**: every step except e2e passed, and e2e could not start a browser.
A side effect showed up: after all specs failed at launch, the local (non-`CI`) Playwright run hung at teardown
with `vite preview` still running and had to be killed. CI sets `CI=true`, which stops Playwright reusing the
server, but this was not checked.

Workflow validation: `actionlint` v1.7.12 (`go run github.com/rhysd/actionlint/cmd/actionlint@latest`), exit 0,
no findings. shellcheck was not installed, so actionlint's shell checks of `run:` blocks were skipped.

## Not verifiable without a remote

- The `windows-latest` job as a whole (EOL/path behaviour, real-Git test timing on Windows).
- The web e2e on `ubuntu-latest` with `--with-deps webkit`.
- gitleaks-action v3 with only `contents: read`. On `pull_request` it lists the PR's commits through the API. That
  works with `contents: read` on public repos. On a private repo it may also need `pull-requests: read`, which the
  brief does not allow; if the step fails for this reason, the owner should decide. PR comments are turned off
  (`GITLEAKS_ENABLE_COMMENTS: false`), because they would need write permission. Personal accounts need no
  `GITLEAKS_LICENSE`; an organisation-owned repo would.
- `pnpm/action-setup` reading `packageManager` and the setup-node pnpm cache on both OSes.
