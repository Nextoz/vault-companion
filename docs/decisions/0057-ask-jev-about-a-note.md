# ADR-0057 — Ask Jev about a note (JN1)

Status: accepted (Lead, 2026-10-06; owner accepted sending note text to TypeSafe on 2026-10-06).
High-risk: `-Reviewer both` (CodeRabbit + GLM second opinion).

## Decision
- **Read-only v1.** On a note open in the app, the owner can send up to 3 typed questions (yes/no, choose, rate) to
  Jev. The Worker reads the note through the existing fixed read path, using the same note ID the app already sends
  (the client never sends note text), then sends note text + questions to TypeSafe's direct API with the pinned model
  `jev-1.13.0` (no moving alias). Answers return typed, each with probabilities.
- **Scope.** Any note in `Notes/` except `Health/` and `Journal/`; those are refused with a typed error.
- **Limits.** State budget is `100,000` characters (v1 refuses `note-too-long` rather than truncating; this sits below
  the ~32k-token budget for typical notes). The TypeSafe call has a 25 s timeout with a plain message (Jev once hung
  >80 s). A per-day rate limit lives in the Worker so a loop cannot spend money.
- **Rate limiter.** There is no existing KV/Durable Object pattern to reuse, so v1 uses a best-effort in-memory daily
  cap of 50 calls per isolate. It resets with a deploy and is approximate across isolates, but still stops an in-app
  loop for the rest of the day.
- **No persistence.** No vault write and no response cache in v1.
- **Logging.** Only operation id, duration, question types and status are logged; never note text, questions or answers.
- **Secret.** The owner sets `TYPESAFE_API_KEY` himself via `wrangler secret put`; nobody reads or logs it.

## Alternatives
- **Direct Worker → TypeSafe (chosen).** Keeps the key server-side, reuses the existing auth/read path and fixed note
  path, and adds no client process. The private-text egress is one accepted, well-known hop.
- **PC-side relay.** Call TypeSafe from the owner's machine: less Worker egress, but note text then crosses the client
  and a secret/process must be installed and kept secure on the PC; rejected.
- **Not doing it.** No new dependency or data egress, but drops the owner's requested feature; rejected.

## Security
Private note text leaves our stack to TypeSafe; the owner accepted this on 2026-10-06. The secret is never in code,
config, logs or review artifacts; use is confined to the TypeSafe direct API. Fixed-field logging and no response cache
keep note text, questions and answers out of our logs and storage.

## Consequences
One new Worker route, typed question/answer schemas, a new outbound dependency and a new spend surface. Read-only means
no CAS/vault mutation work is added. **Undo:** `wrangler secret delete TYPESAFE_API_KEY`, remove the route/config, and
the feature returns a typed refusal; no vault cleanup is needed. Any code using this credential/call is reviewed
`-Reviewer both`.
