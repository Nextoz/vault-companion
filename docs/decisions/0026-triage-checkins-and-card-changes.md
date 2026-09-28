# ADR-0026 — Triage v2: "Did you go?" check-ins, event summary, overlap tags, reasons that stay (T2)

**Status:** accepted (owner decisions after real use, 2026-09-28). Amends ADR-0024 and vault-contract (triage rows).

## Feed (read; produced vault-side)

All additions are **optional** so an older `feed.json` stays valid (unknown fields are still ignored):
- `card.summary`: string ≤ 300 characters, may be `""`; absent ⇒ `""`.
- `card.calendar.clash.kind`: `"go"` (another event the owner said Go to) or `"own"` (an own calendar entry); absent ⇒
  treated as `"own"`.
- `feed.checkins`: array (absent ⇒ `[]`) of `{ eventId (20 hex), title ≤ 300, start (offset date-time) }` for Go
  events that ended in the last 7 days without an answer. A malformed check-in is dropped and counted, never failing
  the feed (same rule as cards).

## Decision line (write; `Events/Triage/Decisions/YYYY-MM.jsonl`, append-only as in ADR-0024)

New decision `"attended"` with an `outcome` of `"worth" | "not-worth" | "missed"`:
`{"schemaVersion":1,"decisionId","eventId","decision":"attended","outcome":"worth","reason":null,"undoes":null,
"explore":false,"at","card":{"title","category":null,"sourceName":null,"aiScore":null,"start"}}` — same key order and
rules as ADR-0024; `outcome` is written **only** for `attended` (and placed right after `decision`); `reason` stays
`skip`-only. `card` carries the check-in's `title` and `start`; the other snapshot fields are `null` (a check-in has no
card). Undo is a normal `undo` line whose `undoes` names the attended decision. Exactly-once, head-CAS, receipts and
path rules are unchanged (the same command `TriageDecide`, extended).

## App behaviour

1. **Check-ins first:** undecided check-ins (no effective `attended` line for that `eventId`) are shown before the day's
   cards and do **not** count toward the 10 daily cards. Three buttons: "Worth it" / "Not worth it" / "Didn't go". No
   swipe gestures on check-in cards (three answers do not map onto swipe directions).
2. **Card layout:** summary first (hidden when `""`), then the existing facts, "why picked" (`card.why`) last.
3. **Overlap tag:** a clash is shown as a tag, never hiding the card: "Overlaps your Go: <title>" (`kind: "go"`) or
   "Overlaps: <title>" (`kind: "own"`). In the same session, a card whose time range overlaps a card the owner just
   swiped Go (pending or saved) gets the same Go tag, because the feed learns about a Go only after the next sync.
4. **Skip reasons stay:** after a left swipe the reason buttons stay visible for at least 3 s and while a pointer/finger
   is on them; the skip is saved when a reason is chosen or when that window closes (reason `null`, as today).

## Why

Skips without a reason wrongly taught the scouts a topic dislike; overlap and "did you go" feedback close the loop that
T promised ("decisions … teach the scouts"). Learning rules (vault-side): `worth` is the strongest Go, `not-worth` a
negative example, `missed` ignored.
