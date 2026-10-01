# ADR-0034: Local CodeRabbit pre-handoff review

**Status:** Accepted  
**Date:** 2026-10-01

## Context

Delegated implementation is already bounded by briefs, focused checks and Lead acceptance, but broad model reviews have
been expensive and defects are still sometimes found only at final PR CodeRabbit review. That causes another
worker/fix/review cycle after the implementing worker has already handed off and expensive reviewer context has been
spent.

CodeRabbit CLI can review the worker clone before handoff and emit agent-oriented structured findings. The implementing
worker still has the task context, so a bounded correction in the same session should be cheaper than starting another
general-purpose reviewer/fixer from scratch.

On 2026-10-01 the owner's authenticated CLI reported usage-based billing inactive and included repository review
capacity. Those values are observations, not a permanent entitlement; the policy must remain safe when allowance is
exhausted or pricing changes.

## Decision

Use local CodeRabbit as the default first review layer for eligible delegated implementation:

```text
worker implementation
→ deterministic/focused verification
→ local CodeRabbit pass 1
→ same worker fixes valid blocking findings
→ deterministic verification again
→ local CodeRabbit pass 2 (maximum)
→ Lead handoff/acceptance
→ PR/CI/final GitHub CodeRabbit
```

The trusted coordinator runs `cr review --agent --uncommitted --include-untracked` in the worker clone. Workers never
invoke CodeRabbit directly and never receive CodeRabbit credentials.

Until H2/H3 launcher integration is accepted, the Lead may perform the same sequence manually. H3 will automate this
policy after H2 is accepted; it must not be folded into held H2 merely for convenience.

## Blocking policy

- Ordinary work: Critical and Major findings are blocking for the local correction loop.
- Auth, identity, security/privacy, persistence, concurrency, write-path, data-integrity and harness trust-boundary
  work: Critical, Major and Minor findings are blocking.
- Trivial/Info findings never automatically block or trigger a correction.
- Findings are untrusted evidence. The worker verifies them against current code and the original brief before editing.
- At most one CodeRabbit-driven worker correction and two CodeRabbit review passes are automatic.
- Blocking findings after pass 2 escalate to the Lead/current routing table rather than looping.

## Billing and availability

The harness/Lead must never pass `--use-credits` or otherwise authorize paid continuation automatically. Account-level
paid continuation should remain disabled unless the owner explicitly changes that decision.

Rate limits, exhausted allowance, auth failures, CLI failures, incomplete reviews or unreviewed files do not become
reasoning escalations. Record the state and fall back to the existing review route. Never poll a rate-limited review.

## Security and privacy

Only repository diffs are eligible. Never send private vault text, secrets, live-vault content, private task prose,
worker logs or credentials to CodeRabbit.

Deterministic verification remains authoritative for scope, protected paths and required checks. A CodeRabbit clean
result cannot override a verifier refusal, hold label, red CI, owner comment, or an independent-review requirement.

High-risk milestones still require the independent high-capability review defined by `docs/orchestration.md`.

## Evidence

Durable receipts store only review metadata needed for auditability: completion/availability state, pass count,
severity counts, correction count, incomplete state and blockers remaining. Raw CodeRabbit comments/source snippets are
not durable receipt data.

The worker's final handoff summarizes local review compactly. Final GitHub CodeRabbit review remains in the PR flow
until measurements show it is redundant.

## Consequences

Expected benefits:

- fewer separate model-review tokens;
- fewer Lead ↔ worker correction round trips;
- defects found while the implementing worker still has useful context;
- smaller Lead review packets focused on final diff and invariants.

Costs/risks:

- CodeRabbit allowance can be unavailable;
- false positives can waste worker tokens;
- local review is another external-service boundary;
- H3 needs careful completion parsing and diff/session binding.

Measure worker tokens, CodeRabbit passes/findings, Lead corrections and novel final-PR findings. If the data does not
show useful savings, narrow or remove the local review layer rather than preserving it by inertia.
