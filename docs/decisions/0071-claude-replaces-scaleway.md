# ADR-0071 — Claude replaces Scaleway for the Morning Brief writer and "Challenge me"

Status: draft (daytime session, 2026-11-12). Owner instruction in chat, 2026-11-12: "I need to stop using scaleway
all together. so use claude instead". Supersedes the provider choice in ADR-0045 and ADR-0063; everything else in
those two ADRs (data minimisation, validation, fallback, rate limit, no logging) is unchanged.
High-risk (outbound private text, new secret): owner confirms the data flow below before merge.

## Context
Two production calls went to Scaleway Generative APIs: the Morning Brief writer (`deepseek-v4-flash-0731`, ADR-0045)
and the Reading follow-up question (`glm-5.2`, ADR-0063). Scaleway retires `glm-5.2` on 2026-11-16, the voucher
ended on 2026-10-31, and the owner is leaving Scaleway.

## Decision
- **Provider and model:** the Claude API (Anthropic), model `claude-opus-5-5` for both calls, one constant
  `CLAUDE_MODEL` in `apps/worker/src/claude-chat.ts`. Effort `low`: both tasks are short phrasing work.
- **Client:** the official `@anthropic-ai/sdk`, with the Worker's injected `fetch` (so the cron's subrequest count
  still sees the call), `maxRetries: 0` (one attempt, as before) and the same deadlines (60 s brief, 30 s follow-up).
  Server-side refusal fallback is on (`fallbacks: "default"`).
- **Contract unchanged:** `ModelChat.chat` returns `ok` with text or a bare `error`. An API error, timeout, refusal,
  a reply cut at `max_tokens` or an empty reply is `error`; the brief then ships as the deterministic fallback and the
  follow-up route answers `follow-up-unavailable`.
- **No forced JSON mode:** the writer prompt already asks for JSON only and `parseWriterOutput` strips a code fence,
  validates with zod and filters against the candidates. This model rejects `temperature`, so none is sent.
- **Secret:** `ANTHROPIC_API_KEY`, an optional Worker secret set by the owner (`wrangler secret put`), never in
  `secrets.required`. `SCALEWAY_API_KEY` is no longer read; the owner deletes it from the Worker and revokes it at
  Scaleway after the first good brief.

## Data flow change (the owner's call)
ADR-0045 rejected US providers because the brief prompt carries private state. That is reversed here on the owner's
instruction. What now reaches Anthropic (United States):
- Morning Brief: the day, meeting count and first start time, free-block times, up to five to-do texts with due dates,
  derived state flags in plain words ("steps below its 30-day median"), **the mood, energy and sleep numbers of the
  latest check-in**, the run window and a training count. No raw health rows, series, mail bodies or calendar titles.
- Challenge me: the text of the one reflection the owner tapped. No title, no other entries.

Open choice for the owner: keep the mood, energy and sleep numbers in the prompt, or drop that one line and send only
the derived flags (`buildWriterPrompt` in `packages/domain/src/morning-brief-writer.ts`).

## Alternatives
- Another EU host for an open model: keeps EU jurisdiction, but it is a new account and key, and the owner asked for
  Claude. Not taken.
- Deterministic-only brief and no follow-up question: nothing leaves the Worker; loses phrasing and the feature.
  Remains the automatic fallback while `ANTHROPIC_API_KEY` is unset.
- `claude-haiku-5-5`: about forty times cheaper per token and enough for this work; a one-line change of
  `CLAUDE_MODEL` if the owner prefers it. At one brief a day and at most five follow-ups the cost difference is cents.

## Not verified
No Claude API key was available to the session that wrote this, so no real request was made. The request shape is
taken from the SDK's types and covered by tests against a fake `fetch`. First real check: the owner sets the secret,
then one Challenge me tap and the next 06:31 brief (`source: "model"` in `Morning Brief - latest.json`).

## Out of scope
Build tooling that still calls Scaleway (`tools/glm-review.ps1`, `handoff-check.ps1`, `intent-review.ps1`,
`launch-worker.ps1` tiers `glm` and `scw`, `scaleway-patch-worker.ps1`, `glm-workflow.mjs`) and the Scaleway rows of
the AI budget and Credit burn-down cards, which read vault files. Tracked separately.
