# ADR-0030 — Cost-aware worker model routing

**Status:** accepted (owner decision, 2026-09-28); amended by explicit owner correction, 2026-10-01.

## Context

The repository accumulated several dated routing tables while model availability and quotas changed. They disagreed
about which Codex models were available, whether routine work should use Astra, concurrency limits, and how reviews
should be routed. Measured usage also showed that parallel high-effort Astra reviews could consume a large fraction of
the available Codex budget before their results could influence later work.

## Decision

`docs/orchestration.md` contains one active routing table and operational policy. **Jev is the default first
System-One layer for compatible cheap structured judgments**, including eligible worker/model/provider selection
(Use 2) and post-worker evaluation (Use 1). Prefer deterministic code for exact decisions. Batch related typed
Choice/Score/Noul questions; keep architecture, ambiguous open-ended reasoning, implementation and difficult
diff understanding with the Lead and generative System-Two models. Jev is neither a worker nor the Lead.

The Lead filters choices by availability, budget, privacy and deterministic risk floors. Eligible choices include
guarded Scaleway GLM-5.2, DeepSeek Flash/Pro and available authorized economical Codex workers. Follow low-risk
routing only with top-choice probability >=0.60, ordinary integrity class and ambiguity <0.50; otherwise record
a Lead fallback. Jev cannot downgrade security/privacy/auth/write-path/persistence/concurrency/data-integrity/
harness/CI requirements, waive required review/current CI/actual CodeRabbit or remove holds.

Every compatible completed worker gets Use 1 completion, verification, scope, silent-failure, unsupported-claim
and redo/escalation evaluation beside the Lead verdict. Only filtered public/synthetic packets go through the
existing authorized `Tools/jev.ps1`; private-note product use requires a separate privacy decision. Unavailable,
low-confidence or malformed results require recorded fallback rather than claimed Jev use.

Keep task/candidate-bound recommendations and actual outcomes in gitignored receipts. Preserve the existing kill
switch: two of the first five Jev-picked runs needing escalation/redo disables active Use 2 routing, reverts it to
shadow and is reported to the owner. Do not reset its history on resume. The Lead chooses the cheapest capable
eligible model and escalates only for verified reasoning/context complexity.

The historical Codex ladder was Luna → Terra → Sol → Astra. Astra-medium was for genuine integrity/security/concurrency
risk; Astra-high is reserved for critical adversarial review and requires a written risk reason in the brief.

Historical concurrency: one Codex worker was the default. Two could run only for genuinely independent work when the Lead judged the
speedup worth the quota; two Astra-high workers never run in parallel. One Claude worker and one Playwright job may run
at a time.

Provider limits, unavailable models, tooling failures and flaky tests are rerouting/fix-the-blocker conditions, not
reasons to increase reasoning effort.

## Consequences

- Current owner instructions supersede historical ladder, concurrency, broader worker-vault access and Claude-only
  review. Current appointment/runtime and queue stay in plan/checkpoint. One active implementation feature, second
  worker only review/bounded close-out, one browser job, no recursion. Lead-only task-relevant live reads;
  no private cloud packets or live/reference-vault writes.
- Fresh independent DeepSeek Pro is the owner-authorized floor reviewer; Lead owns source inspection/integration
  and acceptance. Holds remain until matching verification, required review, current CI and actual CodeRabbit.
- The $3 DeepSeek reserve is removed. Check actual available credits economically before/after dispatch and
  meaningful milestones; never infer top-ups. GLM is owner-authorized inside its verified free-token guard, with
  no paid fallback, billing, credential or provisioning change. GLM does not replace the Pro floor.
- Policy changes update the canonical table, operational entry and this ADR through focused PR/review/merge;
  a new backend requires a verified launcher, a verified spending guard, and a verified small trial. Preserve routing outcome history.

- Historical usage numbers may remain as dated evidence, but historical routing tables do not remain active.
- `CLAUDE.md` points to the canonical routing policy instead of duplicating model IDs.
- Reviews use the same routing ladder as implementation; Astra is not the default reviewer for ordinary diffs.
- The Lead verifies the actual model/effort at launch because product availability can change.
- Free/local backends remain valid for bounded low-risk work but never receive private vault text.
