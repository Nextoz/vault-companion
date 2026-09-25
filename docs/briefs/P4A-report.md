# P4-A report — Read-only linked note context

Branch `agent/linked-notes`. Status: **implemented; `pnpm check` green; e2e green on Chromium; WebKit e2e not run in this
container (see Verification)**. Not pushed: this Cloud session has no `origin`, and the git proxy refuses
`Nextoz/vault-companion` ("not in this session's authorized repository set"), so the branch exists only in the session.

## Design

Request path: tap a wikilink in a task row → `GET /api/linked-note` → domain resolver → one pinned commit X → JSON →
Markdown renderer (raw HTML off) → DOMPurify allowlist → note view.

- **Contracts** (`packages/contracts`): `LinkedNoteRequest = { taskLocator: TaskLocator, linkIndex: 0..99 }` (strict,
  no path field; `TaskLocator.path` is the literal To-Do path). `LinkedNoteResponse` = `{status:'ok', revision, path,
  blobSha, markdown}` | `{status:'refused', revision, code, message}`. The request travels as base64url JSON in the
  `X-VC-Locator` header, with `encode/decodeLinkedNoteHeader` helpers. **Why a header:** a GET query string would put
  task text into URLs, and from there into Cloudflare request logs and browser history. The custom header also forces a
  CORS preflight for any cross-origin caller, and no CORS is configured.
- **Domain** (`packages/domain/src/linked-notes.ts`, no framework imports):
  1. `head()` returns X. Every read (the To-Do list, the listings and the note) uses X.
  2. The To-Do list is parsed with `parseTodoList`, and the task is located by the vault-contract §3 rules, mirroring
     the kernel's private `resolve`. Any failure is `task-changed`.
  3. The target is `task.links[linkIndex]` from the kernel parser, so it is the text before `|`/`#`.
  4. The raw target must pass `isStructurallySafePath` **before** `.md` is appended (otherwise `[[..]]` would become
     the name `...md`). `.md` is appended unless present.
  5. A target containing `/` is an exact path: `parseVaultPath` + `canReadLinkedNote`, and it must appear in the
     regular-file listing of its root. Any other target is a bare name: the unique basename (NFC, case-insensitive)
     among `listFiles` of `Projects/`, `Tasks/`, `Inbox/`, counting only paths that pass the same policy.
  6. `readFile` at X. The blob SHA must equal the listed blob, the 1 MB guard applies, and the file must be valid UTF-8.
- **Store port**: new `listFiles(dir, at)` returns regular files only (100644/100755), recursive, with blob SHAs. It
  returns `[]` only when `dir` is provably absent, and a truncated listing throws `FileTooLarge`. Implemented in
  `InMemoryStore`, `LocalGitStore` (`ls-tree -r`) and `GitHubContentsStore` (`/git/trees/<X>:<dir>?recursive=1`),
  and covered by the shared store contract test.
  **Why regular files only:** the GitHub Contents API *follows* a symlink to an in-repo file, so `Projects/x.md → ../Finance/y.md`
  would otherwise leak a non-allowlisted note. Listing plus the blob cross-check closes this in both adapters.
- `canReadLinkedNote` now also rejects hidden (`.x`) and denied (`.git`, `.obsidian`, `.trash`, `Tools`, `tmp`,
  `output`) folders at **any depth**. This is used only by linked notes.
- **Worker**: `GET /api/linked-note` sits under the existing `/api/*` Access verification. The global security headers
  (`no-store`, CSP, …) apply. A domain refusal is a typed 200, and `invalid`/`upstream-unavailable` are ApiErrors
  (400/503). Logs record route, status, `commitSha` and `errorCode` (`linked-note:<code>`) only: no path hash, text or
  header value.
- **PWA**: `taskSegments` numbers wikilinks exactly like the kernel. A link becomes a button only when its target
  equals `links[i]` from the read, so a tap can never request a different link than the one shown. `NoteView` is a
  full-screen read-only dialog. The renderer is lazy-loaded (main bundle 346 kB; the renderer chunk is 127 kB, 53 kB
  gzip). Nothing is written to IndexedDB, and the service worker already bypasses `/api/*`.
- **Rendering** (`apps/web/src/note/render.ts`) uses two independent layers:
  1. markdown-it with `html:false`, `validateLink` set to http(s) only, images reduced to escaped alt text, and
     wikilinks as escaped `<span class="wikilink">` text.
  2. DOMPurify with an allowlist: 26 tags; `href`, `class` and `start` attributes; `ALLOWED_URI_REGEXP` http(s) only;
     and an `afterSanitizeAttributes` hook that re-checks each href and sets `rel="noopener noreferrer"
     target="_blank"`.

  Wikilinks *inside* a note are plain text, because the contract resolves links only from a current task line.

## Libraries (exact pins, `apps/web` only)

| Package | Version | Why |
|---|---|---|
| `markdown-it` | 15.0.2 | CommonMark and widely used, with raw HTML **off by default** and link validation as a documented hook. It ships its own types, and its 6 small dependencies are all from the same maintainers (mdurl, linkify-it, uc.micro, entities, punycode.js, argparse). |
| `dompurify` | 3.4.16 | The de-facto HTML sanitiser (cure53): actively maintained, zero dependencies, with explicit allowlist options and hooks, and it ships its own types. |
| `jsdom` (dev) | 30.1.1 | DOM for the sanitiser tests only. `@types/jsdom` 30.0.0 (dev). |

`pnpm audit --prod`: no known vulnerabilities. I rejected react-markdown with rehype-sanitize because it pulls in about
50 unified packages, against security.md's "minimal dependencies".

## Refusal table

| Code | When |
|---|---|
| `task-changed` | The To-Do list is missing, not UTF-8 or unparseable; or the locator no longer resolves (changed, removed, or ambiguous twins). |
| `not-found` | No listed note at the exact path; no basename match; or the task has no link at `linkIndex`. |
| `ambiguous` | A bare name matches ≥ 2 notes (case-insensitive) under the allowlisted roots. |
| `outside-allowlist` | `..`, `.`, absolute, drive letter, backslash, `%`, control/separator chars; a denied or non-allowlisted root; a hidden or denied folder at any depth; or served bytes ≠ listed blob. |
| `too-large` | Note > 1 MB (1,048,576 bytes, the adapter's limit); the To-Do list is too large; or a root listing is truncated. |
| `encoding` | The note is not valid UTF-8 (a code added beyond the brief's five; see Open questions). |

## Stricter readings chosen (contract docs unchanged)

- Locator ambiguity (§3 rule 3) is reported as `task-changed`, not `ambiguous`, which is reserved for link resolution.
- Basename matching is case-insensitive under NFC for *counting*. `[[plan]]` resolves to `Plan.md` only if it is the
  sole case-insensitive match, as with Obsidian and the Inbox collision rule. The exact-path branch is case-sensitive.
- Hidden or denied folders are refused at any depth, not only at the root.
- Only regular files are readable, never symlinks or submodules.
- Wikilinks in note bodies are not openable.
- The log records no path hash for this route. The brief says "log no … path", which is stricter than security.md's
  "hash only".
- `apps/worker/src/index.ts` is **not** in the brief's may-change list, so the production composition is not wired
  yet. `Services.readLinkedNote` is optional, and the route answers 404 until it is. Wiring it takes one line (see Open
  questions).

## Mutation evidence

Each guard was broken in place, its covering tests were run, and the file was restored. Script:
`scratchpad/mutate.py`, not committed.

| # | Mutation | Result |
|---|---|---|
| M1 | Allowlisted-root check removed (`canReadLinkedNote`) | killed: `otherRoot ⇒ outside-allowlist` |
| M2 | Nested hidden/denied-folder check removed | killed: `nestedHidden`, `nestedDenied` (+1) |
| M3 | 1 MB guard removed | killed: `1 MB + 1 byte ⇒ too-large` |
| M4 | Ambiguity takes the first match | killed: `several notes … ⇒ ambiguous` |
| M5 | Raw-target structural check removed | killed: `dotdotBare`, `backslash` (+1) |
| M6 | Locator ignored (match by line index only) | killed: `task changed ⇒ task-changed` (+2) |
| M7 | Listed-blob cross-check removed | killed: `adapter serving another blob (symlink follow)` |
| M8 | LocalGitStore keeps symlinks | killed: `omits symlinks` (real Git) |
| M9 | GitHubContentsStore keeps symlinks | killed: `listFiles … regular files only` |
| M10 | GitHub truncated tree accepted | killed: 2 tests |
| M11 | markdown-it `html: true` | killed: 12 tests |
| M12 | `validateLink` accepts any scheme | killed: 10 tests |
| M13 | `rel="noopener noreferrer"` not set | killed: 4 tests |
| M14 | DOMPurify `ALLOWED_URI_REGEXP` permissive | survived: equivalent (the hook still strips the href) |
| M19 | Hook's href check removed | survived: equivalent (the URI regexp still strips it) |
| M20 | M14 + M19 together | killed: `sanitiser alone neutralises javascript:/data: href` |
| M15 | Images rendered as `<img>` | killed: 2 tests |
| M16 | Worker logs the note path hash | killed: `logs neither note text nor path` |
| M17 | Service worker caches `/api/linked-note` | killed: `never intercepts the API` |
| M18 | Request schema made loose (a path could ride along) | killed: `never accepts a client path` |

## Verification

- `pnpm check` (lint + typecheck + test): **32 files, 573 tests passed**. The new tests are:
  - `linked-notes.test.ts` (25)
  - `linked-note.test.ts` for the worker (11) and the contracts (10)
  - `render.test.ts` (66, including a 26-payload XSS corpus through the full pipeline and each layer alone)
  - store-contract `listFiles` ×2 adapters, plus a symlink test on real Git
  - a contents-store `listFiles` test, `taskSegments` tests and an SW policy assertion.
- Web e2e: **9/9 passed on Chromium**, iPhone 15 viewport, production build, run with a temporary local config. It
  includes the new test "open a linked note from a task": sanitised render, `pwned` stays undefined, no task text in
  the URL, and nothing in IndexedDB or Cache Storage.
- **WebKit was not run.** The container has only Chromium, and `playwright install` is off-limits. The committed
  config still targets WebKit, so CI or a local run must confirm it.
- `pnpm build` and `pnpm audit --prod` are clean.

## Open questions

1. **Production wiring** (outside the may-change list). In `apps/worker/src/index.ts`:
   `const services = { ...createCommandService({...}), ...createLinkedNoteService({ store }) };`. Until then
   `/api/linked-note` returns 404 in production.
2. **`encoding` refusal code**: I added it for non-UTF-8 notes rather than render with replacement characters. Keep it,
   or fold it into another code?
3. **Recursive listing cost**: a bare-name link lists three roots recursively (3 GitHub API calls) on every open. That
   is fine at vault scale, but if a root grows past GitHub's 100k-entry/7 MB tree limit, links to it refuse
   `too-large`.
4. **NFD-stored paths** (macOS-created files) are matched under NFC and read by their stored name. This is untested
   against GitHub.
5. The WebKit e2e run is still needed.
