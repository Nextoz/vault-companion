# ADR-0043 — Health ingest endpoint with an Access service token (HC3)
Status: accepted (Lead, 2026-10-02, under the owner's HC3 backlog item and agreed setup). Amends ADR-0008 (auth) and
ADR-0039 (health read) by adding one write target: `Health/Data/Apple Health Daily.csv`.
## Context
The Health panel is days old because the CSV changes only on a manual export. An iPhone Shortcut can read the last
days' samples while the phone is unlocked and POST them, but it cannot complete the email login every other route uses.
## Decision
- One route, `POST /api/health/ingest`, sits behind a **separate Access application on that path only**, whose only
  policy is Service Auth for one service token (`vault-companion-health-shortcut`, 1 year; secret in the owner's
  password manager and the Shortcut only). The Worker verifies that application's JWT itself: RS256, team issuer,
  `aud` = `HEALTH_INGEST_AUD` only, `exp`/`iat` with the same 24 h bound as user tokens, a non-empty `common_name`, and
  **no** `email` claim.
- The general `/api/*` guard skips exactly `POST /api/health/ingest`; every other route (and any other method or
  sub-path) keeps the email allowlist, so the service token is refused everywhere else, and a user token is refused
  on the ingest route. `HEALTH_INGEST_AUD` unset ⇒ the route answers 404 (feature off, nothing else changes).
- The body is parsed strictly (schema version 1, fixed units, numbers without grouping); anything unexpected refuses
  the whole request. An empty `steps` field means Health was locked: refuse, never write zeros.
- Days are Copenhagen dates. Only days fully inside `[from, sentAt]`, plus today as a partial row, are rewritten, with
  the aggregation of `Tools/apple_health_daily.py`. Other rows stay byte-identical; rows are never deleted.
- The write goes through `executeWrite`: CAS on the head, operation ID derived from the body hash, trailers, dedupe.
  Re-sending the same day replaces only that row; identical bytes make no commit.
- Health values never reach errors, logs, AI or fixtures.
## Alternatives
- Reuse the user Access application with a bypass or a shared secret header: widens the main login. Rejected.
- Upload `export.xml` by hand: what we have today; the data stays stale. Rejected.
- A Worker cron pulling from Apple: Health has no server API. Not possible.
## Consequences
- Owner sets `HEALTH_INGEST_AUD` once (`wrangler secret put`) and builds the Shortcut from the Lead's steps.
- Revoking the service token in Access stops ingest without touching the app; the CSV keeps its history.
- Sleep: only "In Bed" samples feed `in_bed_h` (the script's meaning); sleep stages are ignored until asked for.
