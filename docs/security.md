# Security baseline

Applies from the first live slice. Threats and rationale: `docs/threat-model.md`.
This system is **not end-to-end encrypted**: GitHub and the Worker process plaintext vault content.

## Authentication and authorization

- Production: Cloudflare Access in front of the whole hostname (app + API), single allowed identity,
  MFA required by the identity provider policy. Session duration ≤ 24 h. (Provisioning = owner gate.)
- The Worker **independently verifies** the `Cf-Access-Jwt-Assertion` JWT on every `/api/*` request:
  RS256 signature against the team JWKS, `aud` = application AUD tag, `iss` = team domain, `sub`, `email` ∈
  allowlist, **`exp` and `iat` required** with `exp − iat` ≤ 24 h, `nbf` honoured, 5 min clock tolerance (review A6).
  Failing any check ⇒ 401, no body detail. Mutations also require `X-VC-Account` equal to the identity's key.
- Local/test: a dev verifier with a locally generated keypair. The production build refuses to start
  if `AUTH_MODE != access` or the JWKS/AUD bindings are missing.

## CSRF / origin

Mutations are `POST` with JSON only and require: `Content-Type: application/json`,
header `X-VC-Request: 1`, and `Origin` equal to the configured app origin. Anything else ⇒ 403.
No state-changing `GET`. CORS: none (same-origin only).

## Paths

All vault paths validated by `domain/path-policy` against `vault-contract.md` §1 before reaching an adapter.
Adapters additionally reject `..`, leading `/`, backslashes and control characters (defence in depth).

## Rendering

Linked notes render through a Markdown renderer with **raw HTML disabled**, then a sanitiser
allowlist; links: `http(s)` only with `rel="noopener noreferrer"`, wikilinks mapped to in-app routes.
CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`.
Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy` minimal, HSTS.

## Caching

API responses: `Cache-Control: no-store`. Service worker caches the **app shell only**
(hashed static assets); it never caches `/api/*`. No vault content in IndexedDB except the user's
own pending captures (`docs/commands.md`).

## Secrets

GitHub App private key + app/installation IDs as Worker secrets only; installation tokens minted per
request (≤ 1 h), never logged, never sent to the browser. Repository permissions: Metadata read,
Contents read/write, single repository. Nothing secret in this repository; gitleaks in CI.

## Logging

Structured metadata only: request id, route, command type, operation id, status, duration, error code,
GitHub status class, commit/blob SHAs. Vault paths are logged only as a hash (a note path contains its title).
**Never**: task/note text, clear-text paths, search terms,
request/response bodies, tokens. Enforced by a single logger that accepts a typed allowlisted record,
plus a test that runs every command with sentinel text — in task text and in a note's **first line** — and
asserts the sentinel never appears in logs.

## Build and deploy

No public previews: previews disabled or behind the same Access policy. Production source maps not
uploaded publicly; no debug endpoints. Lockfile committed; `pnpm audit` + gitleaks + dependency
review in CI; minimal dependencies (each new runtime dependency justified in the PR).
