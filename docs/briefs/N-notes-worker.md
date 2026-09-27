# Brief N — Notes in the app (worker, Claude Cloud)

Start: `git fetch origin agent/notes-base && git checkout -b agent/notes origin/agent/notes-base` (contract + ADR-0022
already there). **Push a stub handoff within the first 5 minutes** (`git push -u origin agent/notes`), push again at the
end. Do not open a PR, do not spawn agents, do not edit `docs/plan.md`. Synthetic data only.

Read `AGENTS.md` (follow "Worker token economy"), then `docs/decisions/0022-notes-in-the-app.md` (the spec).
Contract (already in `packages/contracts/src/index.ts`): `InboxNotePath`, `EditNotePayload`, `EditNote` command,
`NoteEditedEffect`, `NotesResponse`, `NoteReadResponse`, `MAX_NOTES_LISTED`.

## Build (full stack; reuse existing code)

1. **Kernel** (`packages/vault-markdown`): `splitNote(text)` → `{ bom, frontmatter, body, eol, finalNewline }` or a
   refusal (invalid UTF-8 handled upstream; mixed EOL ⇒ `refused:mixed-eol`); `editNoteBody(text, newBody)` builds
   BOM + frontmatter (byte-identical) + newBody with line breaks converted to the file's EOL and the final-newline state
   kept; identical result ⇒ `refused:invalid-edit`; conflict markers in the current text ⇒ `refused:vault-conflict`.
   Golden-byte tests: LF, CRLF, BOM, no frontmatter, frontmatter only, no final newline, body with `---` lines inside,
   CRLF body typed with LF. Each guard mutation-checked.
2. **Domain** (`packages/domain`): `createNotesService` — `listNotes()` (one listing of `Inbox/` at X, regular files
   directly in it, ADR ordering, cap) and `readNote(path)` (path policy per ADR: `Inbox/<name>.md`, no extra `/`,
   `isStructurallySafePath`, listed regular file with matching blob; reuse the linked-note byte/UTF-8/size guards).
   An `editNotePlan` next to the capture plan in `commands.ts`, through the existing execute path (CAS on the note's
   blob, dedupe, trailers, receipts); `paths.ts` allows update of `Inbox/*.md` (direct children only; add tests that
   subfolders and other roots stay denied). Update `docs/vault-contract.md` §1 (Inbox row) with a pointer to ADR-0022.
3. **Worker** (`apps/worker`): `GET /api/notes`, `GET /api/notes/read` (header `X-VC-Note`, validated with
   `InboxNotePath`), wired like `/api/linked-note` (auth, no-store, no text in logs); route + wiring tests.
4. **Web** (`apps/web`): a **Notes** tab (follow App.tsx tab patterns): list (title, date), tap → note view (reuse
   NoteView / sanitised renderer), **Edit** → a sheet with a textarea prefilled with `body` (frontmatter not shown), Save
   sends `EditNote` with the read's path + blobSha through the existing queue (offline works); saving state and the
   "reaches Obsidian at your next desktop sync" hint as elsewhere; a refused edit keeps the typed text in Actions
   (exportText handles EditNote). `api.ts` `getNotes()` / `getNote(path)` with `.strip()`. After capturing a note, the
   Notes tab shows it after the next read.
5. **Tests:** kernel goldens, domain (list order/cap/symlink/subfolder, read path refusals, edit plan CAS conflict and
   replay), worker routes, web unit, `mock-api.ts` for the three endpoints, ONE Playwright spec (list → view → edit →
   saved), one real-Git e2e in `packages/e2e` (phone edits a note → desktop pull shows exact bytes, frontmatter intact).

Verify (bash): `pnpm exec vitest run packages apps/worker apps/web/src --reporter=dot 2>&1 | tail -12`;
`pnpm exec tsc -b packages/contracts packages/vault-markdown packages/domain apps/worker apps/web 2>&1 | tail -8`;
`pnpm --filter web build`; the one Playwright spec (Chromium is fine in the container; the Lead runs WebKit).
Handoff `.agent/handoffs/notes.md` (≤ 15 lines): completed, discoveries, choices for the Lead, verification.
