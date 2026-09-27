# ADR-0022 — Notes in the app: list, view and edit Inbox notes (increment N)

**Status:** accepted (owner, 2026-09-27, after phone testing: "I added a note, then wanted to see and edit it").
Owner choices: list **all** Inbox notes; edit **any** Inbox note. Amends vault-contract §1 (Inbox: create → create,
read, edit).

## Scope

Only regular Markdown files **directly** in `Inbox/` (no subfolders, as for note capture). Not in v1: delete, move,
rename, notes outside `Inbox/`.

## Read

- `GET /api/notes`: one listing of `Inbox/` at commit X (regular files only; symlinks never listed), newest first by
  the ` - YYYY-MM-DD` suffix of the file name (names without a date sort after, by name), at most 200. Each entry: path,
  title (file name without date suffix and `.md`), date or null, blobSha. No file contents are read for the list.
- `GET /api/notes/read` with header `X-VC-Note: <path>`: the server accepts the path only if it is `Inbox/<name>.md`
  with no further `/`, passes `isStructurallySafePath`, and is in the regular-file listing at X (blob must match);
  then it returns the note like the linked-note response (1 MB cap, UTF-8) **plus** the split of the file into
  `frontmatter` (the leading `---` … `---` block incl. its EOL, or empty) and `body` (everything after).

## Edit

`EditNote { note: { path, blobSha }, body }` (body ≤ 50,000 characters). The new file = original BOM + original
frontmatter bytes (unchanged) + the new body, with the body's line breaks converted to the file's EOL (LF or CRLF, as
detected; mixed ⇒ `refused:mixed-eol`) and the file's final-newline state preserved. Refusals: blob changed since the
read ⇒ `conflict:task-changed` ("the note changed on another device; reload it"), conflict markers in the current file
⇒ `refused:vault-conflict`, path not an Inbox note ⇒ `refused:path`, identical result ⇒ `refused:invalid-edit`
("nothing to change"). Existing CAS/dedupe/trailers/exact-once path (ADR-0005/0011/0015); effect
`{ kind: 'note-edited', path }`. No Undo in v1 (edit again).

## Why

The note text is the owner's own free-form Markdown, so "minimal splice" means: frontmatter and every byte the editor
does not show stay identical, and only the body the owner saw is replaced — optimistic concurrency on the blob makes a
concurrent desktop edit a visible conflict, never a silent overwrite.
