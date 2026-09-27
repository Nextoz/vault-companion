# ADR-0024 — Event triage in the app (increment T Part 2)

**Status:** accepted (owner designed T in the Ready Backlog, 2026-09-27; card design variant C chosen on the phone).
Amends vault-contract §1 (new read root and one new append-only write target). Part 1 (feed builder, triage applier)
is vault-side; the app never touches Calendar or Google credentials.

## Real shapes (captured 2026-09-27 from the first Part 1 output; types and enums only)

- `Events/Triage/feed.json`: `{ schemaVersion: 1, generatedAt, cards[] }`; a card has `eventId` (20 hex), `rank`,
  `explore`, `resurfaced`, `title`, `start` (offset date-time), **`end` nullable**, `location`, `online`, `cost`,
  `registration { state: open | unknown | not-required, deadline: date-time | null }`, `aiScore` (0–100), `why`,
  `category` (open set), `scouts[]`, `sourceName`, `sourceUrl`, `calendar { inCalendar: auto | own | go | null,
  clash: { title, start, end } | null, freeThatEvening }`. The feed is not capped (93 cards, 37 explore).
- `Events/Triage/applied.json`: `{ schemaVersion: 1, updatedAt, decisions: { <decisionId>: { status: applied | failed |
  skipped, at, message } }, problems: [] }`.
- `Events/Triage/Decisions/` does not exist until the first decision.

## Read

`GET /api/triage` at one commit X: `feed.json` (regular file, ≤ 1 MB; unknown fields ignored; a card failing validation
is **dropped and counted**, never failing the feed; absent ⇒ `feedState: 'absent'`; unparseable ⇒ `'unreadable'`),
`applied.json` (same tolerance), and the decision lines of the current and previous month's
`Decisions/YYYY-MM.jsonl` (≤ 1 MB each; a malformed line is skipped). The response carries the parsed cards, the
decision list (decisionId, eventId, decision, undoes, at), the applied statuses, `applied.updatedAt`, and server `now`.
The client derives: undecided cards (latest non-undone decision per event), past events hidden, at most `10 − today's
decisions` cards, `Calendar: pending/applied/failed` per decision, and "Waiting for your PC" when `applied.updatedAt`
is older than one hour while decisions are pending.

## Write — `TriageDecide`

One command appends **one JSON line** to `Events/Triage/Decisions/YYYY-MM.jsonl` (month of `occurredAt` in
Europe/Copenhagen; the file is created on first use): `{"schemaVersion":1,"decisionId":<operationId>,"eventId",
"decision": go | maybe | skip | undo, "reason": topic | too-far | bad-time | too-basic | busy | null (skip only),
"undoes": <decisionId> | null (undo only), "explore", "at": <occurredAt>, "card": { title, category, sourceName, aiScore,
start } }` — keys in this order, one line, `\n` terminated. The file is append-only: existing bytes are never changed
(a golden test proves the prefix is byte-identical). Exactly-once: the command's `operationId` **is** the `decisionId`;
the existing dedupe (trailers) plus a check that no line with that decisionId exists make a retried send a no-op. Head-CAS,
conflict handling and receipts as every other write (ADR-0005/0011/0015). Effect `{ kind: 'triage-decided', path,
decisionId }`. Undo is a new `undo` line, never an edit.

## Paths

Read root `Events/Triage/` (these three files only); write: `Events/Triage/Decisions/<YYYY-MM>.jsonl` only (create or
append). `feed.json` and `applied.json` are never written by the app (one writer per file).

## Privacy

Card snapshots (title, category, source) and clash titles are the owner's own data in the owner's private vault; they
never enter this repository (fixtures are synthetic, derived from the shapes above).
