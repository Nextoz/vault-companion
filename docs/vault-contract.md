# Vault contract

Exact rules for how Vault Companion reads and mutates vault Markdown. Derived from inspected structure
(`docs/discovery/phase-0-findings.md`), never from private content; reconciled with the Phase 0 review.
Any change here is consequential: update the golden tests and record an ADR.

## 1. Allowed paths

| Purpose | Paths | Operations |
|---|---|---|
| Task source | `Tasks/To-Do List.md` | read, complete, undo, edit, append capture |
| Inbox notes | `Inbox/*.md` (regular files directly in `Inbox/`, no subfolders) | create (capture); list, read, body edit with frontmatter/BOM/EOL kept (ADR-0022) |
| Active Work | `Tasks/Active Work Now.md` | read, capture, edit, review, exact Undo (ADR-0019) |
| Training log | `Health/Training Log.md` | read, insert one session row, exact Undo; update only, never create (ADR-0025) |
| Event triage | `Events/Triage/feed.json`, `applied.json`, `Decisions/YYYY-MM.jsonl` | read; create/append **only** decision JSONL, per [ADR-0024](decisions/0024-event-triage.md) |
| Research Radar | `Research/Daily Research Scout/*.md`, `Research/Reading Briefs/*.md`, `Research/Important Research Updates/*.md`, `Research/Explained/*.md`, `Research/Radar/Decisions/YYYY-MM.jsonl`, `Research/Radar/applied.json` | read; create/append **only** the decision JSONL, per [ADR-0032](decisions/0032-research-radar-decisions.md) |
| Research explainer (cron, ADR-0029) | read today's `Research/Reading Briefs/Research Reading Brief - YYYY-MM-DD.md` and `Research/Daily Research Scout/Daily Research Scout - YYYY-MM-DD.md`, list `Research/Explained/`; write `Research/Explained/YYYY-MM-DD - <slug>.md` (directly in the folder, not hidden) | notes: **create**, skipped if that paper's slug already has a note on any date; **update only** to replace this job's own pending note while its blob SHA is unchanged (§4.7); all new notes + the status record in **one** commit (§4.7) |
| Research explainer status | exactly `Automation/Scout Status/research-explainer.json` | create/update (ScoutStatus, ADR-0020; the only writable status file) |
| Linked notes | resolved **server-side** from a wikilink in a current task or Active Work item line (`{taskLocator, linkIndex}`); Active Work requires an exact blob SHA and line match, with `linkIndex` 0; target under an allowlisted root: `Projects/`, `Tasks/`, `Inbox/` (owner decision D2 may widen) | read |
| Never | `.git/`, `.obsidian/`, `.trash/`, `Tools/`, `tmp/`, `output/`, `..`, absolute paths, backslashes, `%`, control chars, non-`.md` — **except** exactly `Automation/Scout Status/<id>.json` (read, ADR-0020; `research-explainer.json` also create/update, ADR-0029) and `Events/Triage/feed.json`, `Events/Triage/applied.json` (read) and `Events/Triage/Decisions/YYYY-MM.jsonl` (read, create/append; ADR-0024) | — |

### Event triage rows

`Events/Triage/feed.json` is the ADR-0024 feed with optional `card.summary` (string, at most 300 characters; absent means
`""`), optional `card.calendar.clash.kind` (`go | own`; absent means `own`), and optional `checkins` (absent means
`[]`). Each check-in is `{ eventId, title, start }`; malformed cards and check-ins are independently dropped and counted.

Decision JSONL rows keep the exact ADR-0024 key order. An attended row is
`{"schemaVersion":1,"decisionId","eventId","decision":"attended","outcome":"worth|not-worth|missed","reason":null,"undoes":null,"explore":false,"at","card":{"title","category":null,"sourceName":null,"aiScore":null,"start"}}`.
`outcome` occurs only on `attended`, immediately after `decision`; `reason` remains skip-only and `undoes` undo-only.

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
A completion is undone at most once (`Vault-Companion-Undoes` trailer); accepted residual under text-equality
semantics: a delayed app Undo can reopen an identical line that the desktop unchecked and another device completed again.
1. **Exact inverse:** if the file at X is byte-identical to the completion commit's blob, the domain writes the
   completion commit's **parent bytes** (the verified original; head-CAS guarantees they are what the completion
   was computed on). Guaranteed to restore the original bytes (acceptance A3). The kernel's own exact inverse must
   only accept a candidate whose re-completion reproduces the **whole effect** (not just the bytes) and must be
   the unique such candidate, else fall through (review A1/R1 — Done above Open).
2. **Semantic inverse** otherwise: locate `completedLineText` among Done indexed tasks (exact, unique; else
   `conflict:task-changed` / `conflict:ambiguous`). Replace the first line with `openLineText`; move the block
   back to Open directly after the nearest preceding **non-blank** line it had (recorded as `anchorBefore`, may
   be the `## Open` heading itself) if that line is unique **and visible** in Open, keeping the recorded number of
   blank lines between (never more than are present); else at the capture insertion point (§4.4).
   **No adoption (review A5/R2):** if the next non-blank line after the insertion point is indented, or the
   insertion would split another task block, refuse with `refused:structure`. The result must leave every other
   task's block length unchanged and give the restored task exactly its completed block's child lines.
   **Blank residue (R7):** if completion inserted a blank line directly before the block (`blankInserted`), the
   semantic inverse removes exactly that one line when it is still present and blank, regardless of other Done content.
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
blank line if present). No subheadings allowed (§2). If the first non-blank Open line is **not a list item**
(prose would become a lazy continuation of the new task — review R14), capture is `refused:structure`.

### 4.5 Edit task (ADR-0017)

Preconditions as for Complete (§4.1): resolved **open** indexed task (ADR-0003 locator resolution), no conflict
markers, one Open/one Done. `refused:duplicate-field` and `refused:unsupported-status` apply; a done/cancelled task
⇒ `refused:already-completed`. `🔁`/`🏁` do **not** block an edit (no completion semantics involved).

Minimal splice on the task's first line only; every other byte of the file (block children, EOL, BOM, final newline)
is unchanged.
1. Parse the line with the existing trailing-field parser: prefix (`- [ ] `), description, fields in original
   order, optional block ID.
2. `text`: replace the description span. `due`/`scheduled`/`priority`: replace the existing token's value **in
   place**; `null` removes the token and its one leading space; a new token is appended after the last field and
   before a trailing block ID (same position rule as `✅`, §4.1).
3. **Round-trip check:** re-parse the new line. It must be an open indexed task whose description equals the
   requested text (or the old one) and whose fields equal the old fields with exactly the requested changes —
   `#todo` and every other tag/field kept. Otherwise `refused:invalid-edit` (e.g. new text ending in `📅 2026-…`
   or a `#tag` that the parser would read as a field, or text that removes `#todo`).
4. No change at all (result identical) ⇒ `refused:invalid-edit` "nothing to change".

Effect: `{ kind: 'edited', beforeLineText, afterLineText }`. Idempotency, CAS, trailers and the one-page dedupe are
the existing execution path (ADR-0005/0011/0015); replay verification compares the recorded effect.

### 4.6 Capture note

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

### 4.7 Research explainer note (cron, ADR-0029)

- Input: items (top-level list items with a link) under `## Read today` of today's brief; if none, under
  `## Most relevant items` of today's scout note. First link per item, `http(s)` only, distinct, ≤ 5, note order;
  pending papers (below) go first, oldest first. The rest of the item's line is the scout's "why".
- Path: `Research/Explained/<Copenhagen date> - <slug>.md`; slug = link text (else URL host + path), NFKD → ASCII,
  lowercase, `[a-z0-9-]`, ≤ 80 chars, never empty.
- Content (LF): frontmatter `type: research-explained`, `created`, `source` and `scout_note` as double-quoted JSON-escaped
  scalars, `model`, `status: complete`; `# <title>`; sections `## In plain words`, `## Key ideas`, `## Why it may matter
  to you`, `## Glossary`, `## Try it`, `## How solid is it`, `## Source`. Model text only from zod-validated JSON, each
  value on one line: control/bidi characters dropped, whitespace collapsed, `& < >` escaped, a leading block marker
  backslash-escaped. Golden: `packages/domain/src/research-explainer.test.ts`.
- Commit: one per run (multi-file head-CAS write), message `Vault Companion: research explainer`, trailers
  `Vault-Companion-Job: research-explainer` and `Vault-Companion-Op: <UUIDv5 of research-explainer:<date>[:catchup]>`.
  The status record's `history[].operationId` makes a re-run of the same slot a no-op.
- Pending (ADR-0029 amendment 2): a picked paper with no explanation (models failed, unreadable, invalid output, or
  over the run's subrequest/time limits) gets its note at once with `status: pending`, `model: ""`, `# <link text or
  URL>`, the line `Explanation pending; retried automatically.` and `## Source` (link, scout's why). It is listed in
  the status record's `pending` (with the note's blob SHA) and retried first for 3 days (first-seen day + 2). A retry
  **replaces** the note only while its blob SHA is unchanged (checked at the commit's pinned base; an owner edit wins and
  drops it from the list). On the 4th day it is rewritten once to `status: unavailable` with the last reason.

### 4.8 Research Radar decisions (ADR-0032)

- Reads: only direct `.md` files in the four research folders listed in §1, the monthly Radar decision file, and
  `Research/Radar/applied.json`. `paperId` is the first 20 hex chars of SHA-256 of the canonical HTTP(S) source URL;
  arXiv `abs`/`pdf`/`export.arxiv.org` forms are one identity. `www.` and generic `source`/`ref` query params are
  preserved because they may identify different content; only unambiguous tracking params are dropped. Note reads are
  resolved server-side from `paperId`, never from a client-named path.
- Decision file: `Research/Radar/Decisions/YYYY-MM.jsonl` (Copenhagen month). Each append is exactly
  `{"schemaVersion":1,"decisionId","paperId","decision":"remove|keep|undo","undoes":null|<UUID>,"at","card":{"title","source","topic"}}`
  followed by one `\n`; existing bytes are preserved. The file must already be valid JSONL with unique, correctly
  targeted decision IDs; malformed/duplicate/foreign/cross-paper Undo files are refused. An Undo may name an earlier
  same-paper decision in the current or immediately previous monthly log, and appends only the current month.
- Same write machinery as commands: operation ID, base revision, head-CAS, blob-SHA precondition, commit trailers, and
  dedupe-before-write. Retries append nothing more; Undo is a new line and never rewrites old history.
- Desktop owns `Research/Radar/applied.json` and `Research/Library`; a Keep stays pending until the desktop records
  `applied` or `failed` for that decision ID. `updatedAt` must be a valid ISO instant, and an `applied` entry must have
  a valid non-null Library path under `Research/Library/`; a `failed` entry may omit that path.

## 5. Refusal codes

`refused:recurring`, `refused:on-completion`, `refused:structure`, `refused:vault-conflict`,
`refused:mixed-eol`, `refused:encoding`, `refused:unsupported-status`, `refused:duplicate-field`,
`refused:path`, `refused:too-large`, `refused:already-completed`, `refused:invalid-edit`, `conflict:task-changed`,
`refused:undo-expired`, `conflict:ambiguous`, `conflict:stale`. Refusals never write.

## 6. Time policy

User timezone `Europe/Copenhagen` (IANA; server setting; device zone ignored). Durable dates are the
user-zone calendar date of `occurredAt`. `occurredAt` > 5 min in the future ⇒ `clock-skew`; > 14 days old ⇒
accepted and flagged `backdated`. `uploadedAt` = commit committer date only.

## 7. Active Work writes

`Tasks/Active Work Now.md` follows [ADR-0019](decisions/0019-active-work-writes.md): exact item grammar,
minimal span edits, section placement, unknown-content preservation and verified exact-inverse Undo.
The app never rewrites existing frontmatter, reformats prose, writes outside §1 or resolves merge conflicts.
