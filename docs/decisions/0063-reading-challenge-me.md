# ADR-0063 — Reading "Challenge me": one optional AI follow-up question (READ1-B)

Status: accepted (Lead, 2026-10-11; owner approved the data flow in chat on 2026-10-11, see `.agent/owner-instructions.md`).
High-risk (outbound private text): `-Reviewer both`.

## Decision
- **Flow.** After a reflection is saved, an optional "Challenge me" button calls `POST /api/books/follow-up` with
  `{ title, date, ordinal }` only. The Worker reads the book note through the existing books read path, takes that one
  reflection entry, and sends **only that reflection text** (no title, no other entries) to Scaleway chat, model
  `glm-5.2`, through the existing `scaleway-chat.ts` client. The reply is validated: one line, a question, 1-300 chars,
  no markdown headings; anything else is a typed error. The client never sends reflection text.
- **Nothing is saved by the call.** The question is shown in the app marked "AI". Only if the owner answers, a second
  command `SaveFollowUp { title, date, ordinal, question, answer }` appends under that dated entry a quoted line
  `> AI question: <question>` followed by the answer paragraph. CAS on the note blob SHA, operation id and exact Undo,
  as for `SaveReflection`. Empty answer refused. The reflection text itself is never edited or generated.
- **Limits.** Per-isolate best-effort daily cap of 5 calls (same pattern as ADR-0057; resets on deploy), 30 s timeout,
  `unavailable` / `rate-limited` / `bad-output` answered with plain messages. No retries.
- **Logging.** Only operation id, duration and outcome class. Never reflection text, question or answer.
- **Secret.** Reuses `SCALEWAY_API_KEY`; without it the route answers `503 follow-up-unavailable`.

## Alternatives
- Jev: rejected, it returns probabilities not prose. No cap persistence (D1/KV): rejected, "nothing in D1" and no
  existing pattern. Client sends the text: rejected, widens the egress surface.

## Security
Reflection text (private) leaves to Scaleway (France) per owner approval. Fixed-field logging, no cache, no storage.
**Undo:** remove the route; saved follow-ups are ordinary quoted lines and stay valid Markdown.
