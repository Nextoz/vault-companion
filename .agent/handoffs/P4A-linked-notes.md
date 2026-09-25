# P4-A linked notes — handoff

## Completed
- Contracts: `LinkedNoteRequest {taskLocator, linkIndex}` (no path field) and a typed `LinkedNoteResponse` (ok or refused:
  `not-found`, `ambiguous`, `outside-allowlist`, `too-large`, `task-changed`, `encoding`), sent in the `X-VC-Locator` header.
- Domain `createLinkedNoteService`: the task is located at one pinned commit, then the wikilink resolves as an exact
  path or a unique basename under allowlisted roots; regular files only, blob cross-check, 1 MB guard.
- Store port `listFiles` (recursive, regular files only) in InMemory, LocalGit and GitHub, plus shared contract tests.
- Worker `GET /api/linked-note`: Access auth, `no-store`, and logs carry only the code and commit.
- PWA: task wikilinks confirmed by the read open a read-only note view. Rendering is markdown-it (HTML off), then a
  DOMPurify allowlist, lazy-loaded. Nothing is stored on the device.
- Report: `docs/briefs/P4A-report.md`.

## Important discoveries
- **The GitHub Contents API follows symlinks.** A symlink under `Projects/` could serve a non-allowlisted note. Now
  closed: only regular files from a tree listing are read, and the served blob must match the listed one.
- **Production is not wired.** `apps/worker/src/index.ts` was outside the may-change list, so the route answers 404 in
  production until `createLinkedNoteService({ store })` is spread into `services`.
- **The push failed.** The session has no `origin`, and the git proxy returns 403 for `Nextoz/vault-companion`. This is
  the same bundle-upload problem as C and P2-A.
- **No WebKit in the Cloud image.** E2e ran on Chromium only.
- `[[..]]` + `.md` = `...md`, a "valid" name. The raw target must be checked before the extension is appended; this is
  now done and tested.

## Recommend
- Fix now: wire `index.ts` (one line); run the WebKit e2e locally or in CI; push this branch after adding the repository
  to the session's sources or installing the Claude GitHub App.
- Follow-up: decide on the extra `encoding` refusal code; add a GitHub probe for NFD paths and recursive-tree limits.
- Leave alone: the redundant sanitiser href guards (M14/M19 are equivalent mutants alone, and killed together).

## Verification
- `pnpm check`: lint and typecheck clean; 32 files, 573 tests passed.
- Web e2e (production build, iPhone 15 viewport): 9/9 passed on **Chromium**. WebKit was not run.
- `pnpm build` OK; `pnpm audit --prod`: no known vulnerabilities.
- Mutations: 20 run, 18 killed; 2 equivalent (redundant href guards), and those two together are killed.

## Commit
See `git log agent/linked-notes`. The final SHA is in the last line of the session output.
