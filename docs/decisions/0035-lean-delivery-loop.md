# ADR-0035 — Lean delivery loop with a Claude Lead

**Status:** accepted (owner decision, 2026-10-01). Supersedes ADR-0030's routing table and every routing/review
amendment made after it.

## Context

From 2026-09-30 to 2026-10-01 a Codex Lead ran the project with DeepSeek workers. Worker logs show about 7.1M
tokens in 2.5 days, 6.2M of them on DeepSeek Pro at high effort (38 of 49 runs). Research Radar (+4.9k lines, one
PR) went through repeated CodeRabbit → repair → independent-review rounds, used over 3M tokens and stayed unmerged
when DeepSeek credit ran out, because a self-imposed "independent Pro review" floor blocked every alternative. The
Lead produced 64 docs-only commits in 18 hours, rewriting state and policy files that contradicted each other, and
spent effort on an orchestration harness (PRs #50/#51) instead of features.

## Decision

1. **Lead:** Claude Opus 5.5 at medium effort, acting as engineer and integrator.
2. **Workers, cheapest capable first:** Gemini (tiny) → Scaleway GLM-5.2 (trial) → DeepSeek Flash (default) →
   DeepSeek Pro medium (high-risk only).
3. **Pre-handoff check** (`tools/handoff-check.ps1`): the worker's candidate is committed, its touched tests run, the
   CodeRabbit CLI reviews the complete delta, and Jev triages each finding (critical/major always fixed). One
   correction round at most.
4. **Review by risk:** ordinary work needs no extra model review; high-risk diffs get exactly one independent review
   (the Lead's own if a worker implemented it). Provider outages reroute; they never block delivery.
5. **One state file** (`docs/checkpoint.md`, ≤ 40 lines, milestone commits only); `docs/plan.md` retired; policy in
   `docs/orchestration.md`, edited in place on owner decisions only.
6. **Jev** is used freely for typed judgments over public repo material; it never accepts work.

## Consequences

- Small slices (≤ ~400 lines) and one correction round bound the cost of any single feature.
- PR-level CodeRabbit becomes optional; the CLI review happens before the Lead spends tokens on a diff.
- High-risk safety is kept by negative tests plus one focused independent review, not by review chains.
- Measure after ~10 slices: tokens per merged slice, correction rounds, findings escaping to PR/phone.
