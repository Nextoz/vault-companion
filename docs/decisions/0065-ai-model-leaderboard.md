# ADR-0065: AI model leaderboard on the Dashboard (LB1)

Date: 2026-10-15 · Status: accepted (owner-requested feature)

## Decision

- Single source: Artificial Analysis free-tier endpoint `GET /api/v2/language/models/free` (official API, `x-api-key` header, one request per sync).
- Rankings use the provider's own established indices (Intelligence Index v4.x as Overall, plus Coding, Agentic and Math where published). We never combine scores across providers or re-weight them ourselves; a missing score is null and hidden from that ranking, never a zero.
- One sync per 24 h, riding the existing `30 4 * * *` explainer cron invocation (the account is at the Workers Free 5-cron cap, so no new trigger). The read is TTL-guarded and inflight-deduped; a cold isolate refetches at most once a day, so opening the Dashboard never bursts provider calls.
- The isolate keeps the last good snapshot and serves it honestly stale (original `syncedAt`) when the provider fails; ranking movement is diffed against the previous in-isolate snapshot.
- No vault writes for benchmark data and no new infrastructure (no KV/D1). Spec fields the free tier omits (context window, modalities, licensing, release date) are shown only when present.
- Secret: `AA_API_KEY`, an optional Worker secret (`wrangler secret put`), same pattern as GEMINI/SCALEWAY keys; unset answers honestly `no-key` and never calls the provider.

## Alternatives considered

- LiveBench (keyless CSVs on GitHub): no established composite of record, no model specs or pricing, per-release multi-file ingestion is fragile. Rejected.
- LMArena: crowd preference votes rather than capability benchmarks; no free official leaderboard API. Rejected.
- Durable snapshots (KV or vault files): would be the first KV use or add third-party data to the personal vault; movement is best-effort in v1. Deferred.

## Consequences and limitations

- Movement history lives only as long as one isolate; a recycled isolate honestly shows no movement.
- The provider publishes no dataset-level timestamp; `syncedAt` is our sync time and the Intelligence Index version is displayed alongside it.
- The scheduled sync shares the explainer invocation's subrequest budget (one extra request).
