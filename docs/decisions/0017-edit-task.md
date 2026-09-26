# ADR-0017 — Edit an existing task (milestone 3, increment B)

**Status:** accepted (owner chose B, 2026-09-26). Amends `docs/vault-contract.md` §1 (new operation on the task
source) and adds §4.5.

## Decision

A new command `EditTask { task: TaskLocator, changes }` edits **one open indexed task's first line in place**.
`changes` names only what changes (at least one):

| Change | Value | Markdown effect |
|---|---|---|
| `text` | new description, 1–2000 chars, single line | replaces the description span only |
| `due` | `YYYY-MM-DD` or `null` | set/replace/remove the `📅` field |
| `scheduled` | `YYYY-MM-DD` or `null` | set/replace/remove the `⏳` field |
| `priority` | `highest…lowest` or `null` | set/replace/remove the priority emoji |

Out of scope for v1: start/created dates, recurrence, tags, moving between sections, deleting, editing child lines,
editing done tasks, Undo of an edit (edit it back), editing in Obsidian-only syntaxes.

## Mutation rules (vault-contract §4.5)

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

## Client (v1)

- Tap a task's text (not its checkbox) → Edit sheet: text, due, scheduled, priority; Save/Cancel.
- Saved edits enter the existing queue (offline works); the row shows the new text with the usual saving state.
- While an edit of a task is not yet reflected, other actions on that row are disabled (an old locator would only
  be refused as `conflict:task-changed` — safe, but confusing).
- A refused edit appears in Actions with the typed text visible and copyable; nothing typed is lost.

## Why

- The owner's first-use feedback: "I need to edit and organize existing tasks, not only capture and complete."
- In-place single-line splice + round-trip parse keeps the "minimal span, golden diff, typed refusal" guarantees
  (AGENTS.md rule 3) and never guesses about Tasks syntax.
- Undo for edits is deferred: an edit is visible and reversible by editing again; a semantic inverse would add a
  second identity problem for little value.
