# Brief P4-A — Read-only linked note context (product contract item 7)

Type: **implementation**, security-relevant. Branch `agent/linked-notes`. Runs as a **Claude Code Cloud** task (Linux).

## Objective

From a task that contains a wikilink, the phone can open the linked note read-only, rendered safely.

Authoritative rules — read before coding, do not restate or reinterpret them:
`docs/vault-contract.md` §1 (linked notes row, "Never" row, wikilink resolution, size guard),
`docs/security.md` "Rendering" and "Caching", `docs/threat-model.md` T3, `packages/domain/src/paths.ts`.

1. **Contracts** (`packages/contracts`): a request `{ taskLocator, linkIndex }` and a response carrying the resolved
   path, revision/blob and the raw Markdown text, or a typed refusal (`not-found`, `ambiguous`, `outside-allowlist`,
   `too-large`, `task-changed`). Reuse the existing locator type; never accept a client path.
2. **Domain** (`packages/domain`, no framework imports): resolve the n-th wikilink of the task line at one pinned
   commit X (the same pinning as reads), validate with `paths.ts`, resolve per the contract (exact path if it has `/`,
   else unique basename among allowlisted roots; 0 or ≥ 2 ⇒ refused), enforce the 1 MB guard, read at X.
   Add store port methods only if needed, implemented in `InMemoryStore`, `LocalGitStore` and
   `GitHubContentsStore` with the shared store contract tests.
3. **Worker:** `GET` route on the existing app, same auth/origin/`no-store` handling as `/api/tasks`; log no note
   text or path (allowlisted logger only).
4. **PWA:** tapping a task's link opens a read-only note view. Render Markdown with raw HTML **disabled**, then a
   sanitiser allowlist; `http(s)` links only with `rel="noopener noreferrer"`; wikilinks become in-app routes (or plain
   text when unresolvable). Pick well-maintained, pinned libraries and justify them in the report. No note content in
   IndexedDB or the service-worker cache.

## Tests (each must fail when its guard is broken — prove at least 4 by breaking them, list them in the report)

Resolution: exact path, unique basename, ambiguous, missing, `..`/absolute/backslash/`%`/`.obsidian/` targets refused,
non-allowlisted root refused, > 1 MB refused, task changed since the locator ⇒ `task-changed`. Worker: 401 without
token, `Cache-Control: no-store`, no text in logs. Rendering: XSS corpus (`<script>`, `on*=` handlers,
`javascript:`/`data:` links, inline SVG, raw HTML blocks, markdown-image `javascript:`) renders inert. One WebKit
e2e: open a linked note from a task via the mock API. Fixtures synthetic only.

## May change

`packages/contracts/**`, `packages/domain/**`, `packages/github/**` (port implementations + contract tests only),
`apps/worker/src/app.ts` (new route only), `apps/web/**`, lockfile, `docs/briefs/P4A-report.md`.

## Must not change

Write paths, command services, kernel mutation code, auth/CSRF logic, other docs. If the contract is ambiguous,
choose the stricter reading and record it in the report instead of editing contract docs.

## Verify and report

`pnpm check` and web e2e green. Report `docs/briefs/P4A-report.md`: design, libraries + versions, refusal table,
mutation evidence, open questions. **Push early** (report stub within the first minutes), push again when done.
Final line: `P4A DONE <commit-sha> — docs/briefs/P4A-report.md`.
