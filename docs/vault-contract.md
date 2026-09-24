# Vault contract

Exact rules for how Vault Companion reads and mutates vault Markdown. Derived from inspected structure
(`docs/discovery/phase-0-findings.md`), never from private content; reconciled with the Phase 0 review.
Any change here is consequential: update the golden tests and record an ADR.

## 1. Allowed paths

| Purpose | Paths | Operations |
|---|---|---|
| Task source | `Tasks/To-Do List.md` | read, complete, undo, append capture |
| Note capture | `Inbox/*.md` (new files only, no subfolders) | create |
| Read-only context | `Tasks/Active Work Now.md` | read |
| Linked notes | resolved **server-side** from a wikilink in a current task line (`{taskLocator, linkIndex}`), target under an allowlisted root: `Projects/`, `Tasks/`, `Inbox/` (owner decision D2 may widen) | read |
| Never | `.git/`, `.obsidian/`, `.trash/`, `Tools/`, `tmp/`, `output/`, `..`, absolute paths, backslashes, `%`, control chars, non-`.md` | — |

Paths are vault-relative, `/`-separated, NFC-normalised, validated by `packages/domain/src/paths.ts` before any
adapter sees them; adapters re-check. There is no endpoint that reads an arbitrary client-supplied path.
Wikilink resolution: exact vault-relative path if the link contains `/`, else unique basename match among
allowlisted roots; zero or several matches ⇒ refused.

Size guard: files are read with the raw media type; > 1 MB ⇒ `refused:too-large`.

## 2. Task lines (Tasks 8.0.0 compatible)

A **task line** matches (Tasks bundle regex) `^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$`, outside
frontmatter, fenced code blocks (```` ``` ````/`~~~`), `%% … %%` comment blocks and `<!-- … -->` blocks.

**Sections.** A heading line is `^(#{1,6})[ \t]+(.*?)[ \t#]*$`; section title compared after trimming.
`## Open` / `## Done` sections end at the next heading of level ≤ 2. For every read and write:
exactly one `## Open` and exactly one `## Done` heading, else `refused:structure` (writes) / banner (reads).
Any heading of level ≥ 3 inside `## Open` ⇒ capture is `refused:structure` (QuickAdd's subsection behaviour
is not reproduced). **Conflict markers** — any line matching `^<{7} `, `^={7}$`, `^>{7} ` or `^\|{7} ` anywhere
in the file ⇒ every write `refused:vault-conflict`, reads show a conflict banner (review F6).

**Indexed task** (first release): a task line inside `## Open` or `## Done` with indentation `""` and tag
`#todo`. Status char `' '` = open; `x`/`X` = done or cancelled; anything else ⇒ read-only.

### Trailing fields

Mirror Tasks: first strip a trailing block ID ` ^[A-Za-z0-9-]+$` (kept aside); then repeatedly strip, from the
**end**, one of `<emoji>️? *<value>$` (after trimming trailing whitespace) or a trailing `#tag`, until
nothing matches.

| Emoji | Field | Value |
|---|---|---|
| `🔺 ⏫ 🔼 🔽 ⏬` | priority | none |
| `📅` due, `⏳` scheduled, `🛫` start, `➕` created, `✅` done, `❌` cancelled | date | `YYYY-MM-DD` |
| `🔁` | recurrence | `[a-zA-Z0-9, !]+` |
| `🆔` | id | `[a-zA-Z0-9-_]+` |
| `⛔` | dependsOn | id list |
| `🏁` | onCompletion | `[a-zA-Z]+` |

The rest is the **description**. Non-trailing markers stay in the description and are not interpreted
(identical to Tasks). `[x]` with a parsed `❌` ⇒ cancelled; with `✅` ⇒ done; with neither ⇒ done, no date.

Read-only reasons (completion refused, task still displayed): `refused:recurring` (`🔁`),
`refused:on-completion` (`🏁`), `refused:duplicate-field` (a field kind twice), `refused:unsupported-status`.

### Task block

The task line plus following lines indented strictly deeper (tab = 4 columns). A blank line belongs to the
block only if the next non-blank line is indented deeper than the task line.

## 3. Locator (first-release identity — ADR-0003)

```
TaskLocator = { path, blobSha, lineIndex, lineText, occurrencesAtRead }
```

`lineText` = exact line without EOL; `occurrencesAtRead` = number of indexed task lines with identical text in
the blob that was read. Resolution against the file at commit X:

1. Blob at X = `blobSha` and line `lineIndex` equals `lineText` ⇒ resolved.
2. Else, only if `occurrencesAtRead == 1`: exactly one indexed line with identical text ⇒ resolved (safe
   replay); zero ⇒ `conflict:task-changed`; more ⇒ `conflict:ambiguous`.
3. Else (`occurrencesAtRead > 1` and blob changed) ⇒ `conflict:ambiguous` (review F2).

Native `🆔` is parsed and preserved; the first release never writes one.

## 4. Mutations

All mutations are **line-span splices** over the decoded text; everything outside the span is byte-identical.
Blank lines are never added or removed except where a rule below says so.

**EOL:** all-LF or all-CRLF; mixed or lone `\r` ⇒ `refused:mixed-eol`; no line break at all ⇒ LF.
Inserted lines use the file's EOL. **Final newline:** the file's has/has-not-final-newline state is preserved:
removing the last line of a file without a final newline also removes the preceding EOL; inserting after the
last line of such a file adds the EOL before the new line and none after (review F16).
**BOM** preserved. **Unicode** never normalised; invalid UTF-8 ⇒ `refused:encoding`.

### 4.1 Complete

Preconditions: resolved open indexed task, no read-only reason, no conflict markers, one Open/one Done.
1. New first line = original with `[ ]` → `[x]` and ` ✅ <doneDate>` appended after the last field
   (trailing spaces/tabs trimmed) and **before** a trailing block ID if present (` … ✅ 2026-09-24 ^abc`).
2. Remove exactly the task block's lines from Open (no blank lines touched).
3. Insert the block into `## Done` directly before the first top-level task line in Done (newest first).
   If Done has no task line: after the last non-blank line of the Done section, preceded by one blank line
   when that line is not a list item.
4. A task already inside `## Done` (open item in Done) is completed in place (no move).

Effect: `{ completedLineText, openLineText, removedAt, blockLineCount, insertedAt, anchorBefore, blankLinesAfterAnchor,
completedInPlace, doneDate, resultBlobSha }` (`anchorBefore` = nearest preceding non-blank line in Open, possibly the
heading). `doneDate` = user-zone date of `occurredAt` (§6).

### 4.2 Undo completion

Input: the server-derived completion effect (commands.md) and the file at X.
1. **Exact inverse:** if the file at X is byte-identical to the completion's result blob, apply the inverse
   splice (remove block at `insertedAt`, re-insert original block at `removedAt`). Guaranteed to restore the
   original bytes (acceptance A3).
2. **Semantic inverse** otherwise: locate `completedLineText` among Done indexed tasks (exact, unique; else
   `conflict:task-changed` / `conflict:ambiguous`). Replace the first line with `openLineText`; move the block
   back to Open directly after the nearest preceding **non-blank** line it had (recorded as `anchorBefore`, may
   be the `## Open` heading itself) if that line is unique in Open, keeping the recorded number of blank lines
   between; else at the capture insertion point (§4.4).
3. Completed-in-place: revert the line in place.

### 4.3 Capture task

Text sanitisation: every Unicode line/paragraph separator (`\r`, `\n`, U+0085, U+2028, U+2029) and every C0/C1
control char is replaced with a space, runs of whitespace collapse to one space, trimmed; empty ⇒ `invalid`.
Line: `- [ ] <text>[ <context>] #todo[ <priority>][ 📅 <due>] ➕ <createdDate>` (QuickAdd/documented order).
Emoji fields typed inside `<text>` are kept verbatim (QuickAdd behaviour). `context` (optional) is a wikilink
`[[…]]` or an http(s) URL, validated.

### 4.4 Capture insertion point (owner decision D4, 2026-09-24 — ADR-0010)

**Top of Open:** immediately before the first non-blank line of the `## Open` section, so desktop QuickAdd
(which appends at the end) and phone captures touch distant lines and merge cleanly (spike S6 vs S5b).
If Open has no non-blank line: after the heading, preceded by exactly one blank line (reusing an existing
blank line if present). No subheadings allowed (§2).

### 4.5 Capture note

Path `Inbox/<Title> - <YYYY-MM-DD>.md`, collision suffix `Inbox/<Title> - <YYYY-MM-DD> (n).md`, n ≥ 2.
- Title = first non-empty line, sanitised as §4.3, then `\/:*?"<>|#^[]%` removed (`%`: the path policy rejects it,
  K report gap 12), leading dots removed,
  truncated to 60 code points at a word boundary; empty ⇒ `Note`.
- **Collision (review F7):** list `Inbox/` at X and treat any existing name equal under
  `casefold(NFC(name))` as taken (Windows desktop is case-insensitive). Create-without-sha is still the
  final guard.
- Content (LF): YAML frontmatter `date`, `created` (ISO instant), `type: inbox-note`, `status: open`,
  `source: vault-companion`, `tags: [inbox]` (block list), and `context` as a **double-quoted, escaped**
  YAML scalar when provided; blank line; the original text with `\r\n` and lone `\r` → `\n`, NUL rejected,
  trailing newline ensured. URLs untouched.

## 5. Refusal codes

`refused:recurring`, `refused:on-completion`, `refused:structure`, `refused:vault-conflict`,
`refused:mixed-eol`, `refused:encoding`, `refused:unsupported-status`, `refused:duplicate-field`,
`refused:path`, `refused:too-large`, `refused:already-completed`, `conflict:task-changed`,
`conflict:ambiguous`, `conflict:stale`. Refusals never write.

## 6. Time policy

User timezone `Europe/Copenhagen` (IANA; server setting; device zone ignored). Durable dates are the
user-zone calendar date of `occurredAt`. `occurredAt` > 5 min in the future ⇒ `clock-skew`; > 14 days old ⇒
accepted and flagged `backdated`. `uploadedAt` = commit committer date only.

## 7. What the app never does

Bulk-add IDs; trim or archive `## Done`; rewrite existing frontmatter; reformat tables/prose; touch
`Tasks/Active Work Now.md`; write outside §1; resolve a merge conflict.
