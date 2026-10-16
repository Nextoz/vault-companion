# ADR-0066: Durable AI model leaderboard on the Dashboard

Date: 2026-10-16 · Status: accepted (owner-requested feature)

## Decision

Use Artificial Analysis's authenticated free-tier model endpoint as one source of published indices. Overall is its Intelligence Index; Coding, Agentic and Mathematics appear only when values exist. We do not combine providers or manufacture missing model specifications. Profession/composite indices are not labelled as individual benchmark results. The UI attributes the source, links its methodology and shows the provider's index version.

Fetch all pages of `/api/v2/language/models/free?page=N` before publishing. Validate pagination, index version consistency, conflicting duplicate slugs and response structure. The total refresh has a ten-second deadline, ten-page limit and two-MiB response limit. A failed page leaves the previous dataset intact. Test data is synthetic or from previously documented examples; the live licensed feed is never committed.

Store the current and previous successful daily snapshots together under one Workers KV key. A single write publishes the dataset and its history. Readers validate persisted data and retain the true sync timestamp on failure. A failed write cannot be reported as a fresh durable snapshot. KV is eventually consistent: another location can briefly see the previous snapshot. This is acceptable for a daily leaderboard; this design does not claim a distributed lock or transactional multi-writer history.

`GET /api/leaderboard` uses the existing authentication middleware and `no-store` response policy. It reads durable data only and cannot trigger an upstream provider request. Missing configuration/data returns a typed unavailable response and does not affect other routes.

Refresh on the existing `30 4 * * *` UTC cron, before the research explainer. Both provider and KV operations count against the invocation's existing request budget. No sixth cron trigger and no personal-vault writes. A UTC calendar-day gate avoids skipping a day when a later cron arrives a few seconds earlier than the previous day's invocation. Concurrent calls on the same source instance share one refresh promise.

`AA_API_KEY` is an optional Worker secret. `LEADERBOARD_KV` is the optional durable binding. Both must be configured before enabling the live feature. Missing KV never silently falls back to volatile-only success.

## Presentation and history

Show at most ten models per available category, with a payload containing the union of those rankings (up to forty). Missing scores/specifications stay unavailable. Movement is the difference between two successful overall rankings; suppress it in other category rows and across Intelligence Index version changes. Detail sheets explicitly identify movement as overall. A snapshot older than the freshness window is labelled stale, retaining its original sync time.

## Alternatives

- In-memory-only snapshots were rejected because Worker restarts erase history and last-good data.
- Personal-vault storage was rejected to keep provider data separate from the owner's knowledge records.
- LiveBench/LMArena were not combined with Artificial Analysis: different methodologies do not produce a comparable synthetic ranking.

## Verification and deployment

Focused tests cover pagination, partial failures, bounds, duplicate data, durable restoration/history, failed writes, read-only requests, authentication, real production composition and cron isolation. Mobile browser tests cover top-ten/category display, source attribution, detail sheets, stale data and unavailable storage. Full regression tests, builds, browser tests, CodeRabbit and CI gate release. Configure the KV namespace and Worker secret before merge/deployment; never commit the key.

Sources: [Artificial Analysis API](https://artificialanalysis.ai/documentation), [Workers KV bindings](https://developers.cloudflare.com/kv/concepts/kv-namespaces/), [KV consistency](https://developers.cloudflare.com/kv/reference/faq/).
