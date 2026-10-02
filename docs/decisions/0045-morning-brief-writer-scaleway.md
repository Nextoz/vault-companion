# ADR-0045 — Morning Brief writer model on Scaleway (EU)

Status: draft (Lead, 2026-10-02) under the owner's MB backlog item; consequential because private health, mood, mail
and calendar data leaves the Worker for a third-party inference API.

## Context
MB1b gathers the day's candidates; a model must select from them and phrase a short brief. The inputs are the owner's
health metrics, mood check-ins, to-do text and calendar titles — the most sensitive data the product handles. The
owner's criterion is that it must not be visible to other people, governments or criminals.

## Decision
- **Provider:** Scaleway Generative APIs in Paris (EU) only. The model DeepSeek V4 Flash is hosted on Scaleway
  hardware, so prompts never reach DeepSeek's own API or China. `BRIEF_MODEL = 'deepseek-v4-flash-0731'`.
- **Data minimisation:** the prompt carries derived flags and plain-word labels only — "steps below its 30-day
  median", mood/energy/sleep numbers, block times, candidate to-do text and due dates. Never raw metric rows, the
  30-day series, CSV rows, or mail bodies and calendar text beyond the title. Mail is limited to Jev-labelled
  metadata (sender, subject, date, labels) per ADR-0044.
- **Secret:** `SCALEWAY_API_KEY` is a Worker secret only, sent as a bearer token; it is never logged, returned or
  written. Model text is never logged either — only an outcome class leaves `scaleway-chat.ts`.
- **Failure is safe:** one attempt, then code validates the reply (zod) against the candidate ids and long blocks
  and, on any error, empty or unusable reply, renders a deterministic fallback brief. The brief always ships.
- **Only candidates:** `parseWriterOutput` drops unknown or duplicate ids and gaps on non-long blocks, so the model
  can select only from what it was given and cannot invent a commitment or a fact.

## Alternatives
- US providers (OpenAI, Anthropic, Google Vertex): data under US jurisdiction; fails the owner's criterion. Rejected.
- DeepSeek's own API: data leaves the EU for China. Rejected.
- Gemini (already used for paper explanations): same jurisdiction problem and a second phrasing contract to keep in
  sync. Rejected.
- Deterministic-only brief (no model): loses selection and phrasing quality; kept as the fallback instead. Rejected.

## Consequences
The owner accepts Scaleway and its subprocessors as a processor for derived health/mood/task/calendar labels, not
raw rows. A leaked Worker key spends the owner's Scaleway quota but has no vault write path. If Scaleway is down or
the key is unset, the brief degrades to the fallback and nothing else fails.
