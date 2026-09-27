# ADR-0019 — Active Work in the app: minimal line writes to `Tasks/Active Work Now.md` (increment C)

**Status:** accepted (owner approved brief C, 2026-09-26). Supersedes vault-contract §7's "never written" for this
file, **only** for the operations below. Brief: `docs/briefs/C-active-work.md`.

## Item grammar

An **item** is a line inside `## Now`, `## Parked` or `## Dropped or done` matching (after the list marker):
`- [ ] **<name>:** <outcome> Next: <next> ⏳ YYYY-MM-DD <[[link]]>` — `outcome`, `Next: <next>`, `⏳ date` and a
trailing `[[link]]` are each optional; `name` is required. Any other line in a section (prose, plain bullets,
headings, blank lines, frontmatter) is **unknown content**: shown read-only where relevant ("edited in Obsidian"),
never rewritten, moved or dropped. Sections are `##` headings compared after trimming; any other section (e.g. Rules,
related notes) is preserved byte for byte. Frontmatter, BOM, EOL and final-newline rules as vault-contract §4.

## Operations (new commands, one file, minimal splice)

| Command | Effect on the file |
|---|---|
| `CaptureActiveWork {name, next?, review?, link?}` | one new item line **after the last item line of `## Now`** (before trailing prose); if `## Now` has no item, directly after the heading line (plus the blank-line rule of capture) |
| `EditActiveWork {item, changes{name?, next?, review?}}` | in-place splice of that item's spans; round-trip re-parse must yield exactly the requested item, else `refused:invalid-edit` (as ADR-0017) |
| `ReviewActiveWork {item, action:'keep'}` | ⏳ set to **today + 7 days** (Europe/Copenhagen) in place (the item is being reviewed now; old date + 7 could still be overdue) |
| `ReviewActiveWork {item, action:'done'}` | line removed from its section; `[ ]`→`[x]` and ` ✅ <today>` appended; inserted after the last list line of `## Dropped or done` |
| `ReviewActiveWork {item, action:'park'}` | line moved unchanged to after the last list line of `## Parked` |
| `ReviewActiveWork {item, action:'drop', reason}` | line removed; ` ❌ <today> <reason>` appended (reason: 1–200 chars, single line); inserted like done |
| `UndoActiveWork {target, targetCommit}` | **exact inverse only**: if the file is byte-identical to the target commit's blob, write the parent's bytes (ADR-0013 pattern); otherwise `refused:undo-expired`-class refusal "undo it in Obsidian" |

A missing target section (`## Parked`, `## Dropped or done`) is created only when needed: inserted before `## Rules`
if present, else at the end, as `## <name>` + blank line. Moves never touch any other line (golden-diff tests prove
it). Items are addressed with an `ActiveWorkLocator` (same shape and resolution rules as the task locator,
ADR-0003, with this file's path). Every write uses the existing CAS, dedupe, trailers and exact-once path
(ADR-0005/0011/0015).

## Read model

`GET /api/active-work` returns, besides the current raw fields, the parsed `## Now` items (name, outcome, next, review
date, link, locator, `needsReview` = review date before today) and the unknown lines of `## Now` as read-only text.
`needsReview` is derived on read; the app never moves a line on its own.

## Out of scope

AI suggestions, automatic moves, notifications, limits, reordering, semantic Undo, editing Parked/Dropped items.
