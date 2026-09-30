# ADR-0030 — Cost-aware worker model routing

**Status:** accepted (owner decision, 2026-09-28).

## Context

The repository accumulated several dated routing tables while model availability and quotas changed. They disagreed
about which Codex models were available, whether routine work should use Astra, concurrency limits, and how reviews
should be routed. Measured usage also showed that parallel high-effort Astra reviews could consume a large fraction of
the available Codex budget before their results could influence later work.

## Decision

`docs/orchestration.md` contains one active routing table. The Lead chooses the **cheapest model reasonably capable of
passing a bounded brief and its acceptance checks**, then escalates one tier only when verification exposes genuine
reasoning/context complexity.

The default Codex ladder is Luna → Terra → Sol → Astra. Astra-medium is for genuine integrity/security/concurrency
risk; Astra-high is reserved for critical adversarial review and requires a written risk reason in the brief.

One Codex worker is the default. Two may run only for genuinely independent work when the Lead explicitly judges the
speedup worth the quota; two Astra-high workers never run in parallel. One Claude worker and one Playwright job may run
at a time.

Provider limits, unavailable models, tooling failures and flaky tests are rerouting/fix-the-blocker conditions, not
reasons to increase reasoning effort.

## Consequences

- Owner update 3 (2026-09-30): DeepSeek is the default implementation backend (Flash; Pro for Sol-medium/floor), trusted with all vault data; up to three independent workers, no required sandbox or B3 graduation gate; $3 stop, Lead diff review, one Playwright job, and held floor PRs with later independent Claude review remain.

- Historical usage numbers may remain as dated evidence, but historical routing tables do not remain active.
- `CLAUDE.md` points to the canonical routing policy instead of duplicating model IDs.
- Reviews use the same routing ladder as implementation; Astra is not the default reviewer for ordinary diffs.
- The Lead verifies the actual model/effort at launch because product availability can change.
- Free/local backends remain valid for bounded low-risk work but never receive private vault text.
