# ADR-0056 — Calendar link identity survives unrelated task-file edits

Status: accepted (Pro, 2026-10-06). Amends ADR-0052.

## Context

ADR-0052 stored Calendar links in `Automation/Calendar Links.json` under an `itemKey`. CAL-b built that key from the
whole-file blob SHA, line index, and line text (`calendar-sheet.ts` task key and Active Work analogue). Any edit
elsewhere in the same task file changes the blob SHA and shifts line indexes, so unchanged items detached from their
calendar links even though the item text had not changed.

The identity must be stable across unrelated edits but still tell identical lines apart. Editing the item itself is
accepted as detaching its link: the new text is a different item from the link file's point of view.

## Decision

- **Stable key shape:** `task:<ordinal>:<normalised line text>` for To-Do tasks and
  `active:<ordinal>:<normalised line text>` for Active Work items. The kind maps to the fixed vault file, so the path
  is never needed in the key. Normalisation is NFC plus control/Unicode separator removal.
- **Ordinal, not line index:** each locator gains `occurrenceIndex`, the 1-based ordinal among identical indexed
  lines in the blob that was read. `packages/vault-markdown` computes it when parsing To-Do and Active Work, and the
  read services put it on `TaskLocator`/`ActiveWorkLocator`. The field is optional on the wire so already-persisted
  queue envelopes from before this change still parse.
- **No blob SHA or line index in the key:** these are read-locator fields for command resolution only, never durable
  calendar identity.
- **Key size:** `CalendarItemKey` grows from 512 characters to `MAX_TASK_LINE + 32`, so the full normalised line text
  fits without a lossy truncation.

## Migration

Pre-ADR-0056 keys are still parseable as `kind:<blobSha>:<lineIndex>:<text>`.

- `GET /api/calendar/links` best-effort resolves a legacy key to its current ADR-0056 key by reading the fixed task
  file and matching the text to exactly one current indexed line. Ambiguous duplicate lines are omitted, never bound
  to a guess.
- The next calendar write rewrites the legacy key to the new key and reuses the existing `eventId`/`operationId`; no
  Google insert is made. A truncated legacy key (old 512-character cap) is treated as recoverable ambiguity and
  returns `calendar-link-needs-recheck`, not a duplicate event.
- Multiple matching legacy keys return `calendar-link-needs-recheck` before any Google call.

## Undo

Revert this change by restoring the pre-ADR-0056 `taskCalendarKey`/`activeWorkCalendarKey` (blob SHA + line index +
text) and the 512-character `CalendarItemKey` cap, then removing `occurrenceIndex` from the locators and the two
vault-markdown parsers. Links written under the new shape would need to be removed or re-keyed by hand; there is no
automatic reverse migration.
