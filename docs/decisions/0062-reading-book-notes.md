# ADR-0062: Reading book notes (`Books/<Title>.md`), commands StartBook / LogReading / SaveReflection

Status: accepted (Lead, READ1-A1, 2026-10-11; owner promoted READ1 on 2026-10-09). Amends vault-contract §1 (one new
create target and its update rules).

## Note format

Path `Books/<Title>.md`, `<Title>` sanitised (no `/ \ : * ? " < > |`, no leading dot, trimmed, 1-80 chars; an
unusable title is `refused:book-title-invalid`). `Books/Reading Queue.md` is never read for writes and never changed.

```
---
type: book
status: reading
author: <text>
totalPages: <int>
---
# <Title>

## Progress
- 2026-10-10: p. 40

## Reflections
### 2026-10-10
<text>
```

The current page is the latest `- YYYY-MM-DD: p. N` line under `## Progress`; frontmatter is never rewritten by a log.
`status: done` is set only by an explicit `FinishBook` (out of A1 scope). Missing `## Progress`/`## Reflections`,
or two of either heading ⇒ `refused:book-note-shape`. Text outside the spliced span stays byte-identical (BOM, EOL).

## Commands

| Command | Effect |
|---|---|
| `StartBook {title, author, totalPages}` | create the note; an existing path ⇒ `refused:book-exists` (no overwrite, no duplicate). |
| `LogReading {title, page, date}` | append one Progress line at the end of the section; `page` ≤ current page or > totalPages ⇒ `refused:book-page-invalid`. |
| `SaveReflection {title, date, text}` | append `### <date>` + text under `## Reflections`; same-day reflections are separate entries; empty/whitespace text ⇒ `refused:book-reflection-empty`. Text is stored verbatim, never edited by AI. |
| `Undo*` | exact inverse only (ADR-0025 pattern): byte-identical file ⇒ parent bytes (for StartBook: delete only if the file is still the created bytes); else refuse. |

Every write: operation ID, base revision, CAS on blob SHA, commit trailers, dedupe before write (as ADR-0053).
Stale base ⇒ explicit conflict, never a merge.

## Privacy

Reflection text is private vault text: fixtures are synthetic, nothing of it in logs. "Challenge me" (READ1-B, an
outbound data flow to Scaleway) needs its own ADR and owner approval; not part of this ADR.
