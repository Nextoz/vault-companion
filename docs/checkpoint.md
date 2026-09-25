# Checkpoint — 2026-09-25 (Milestone 1: integrated first-release build)

**HEAD:** `main`, clean. CI (GitHub Actions) gates every PR. Plan, milestones, workers, targets: `docs/plan.md`.

## In flight (all Claude Code Cloud; branches appear on origin when pushed)

P2-A fixes (PR #4) · P2-B offline e2e · P3-A deploy scaffold · P4-A linked notes · P4-B client correctness ·
P4-C draft recovery. Session IDs in `docs/plan.md`. Watcher: `tools/wait-for-work.sh` (background) wakes the Lead on
new branches, CodeRabbit reviews, finished CI and finished Codex logs.

## Exact next actions

1. For each pushed branch: open PR → CodeRabbit loop → CI green → read `.agent/handoffs/<brief>.md` and disposition
   every discovery in the PR comment → merge. P4-A also gets an Astra adversarial review first.
2. After **all** milestone-1 streams merge: run the whole-system review on the combined build (Phase 2 gate (`docs/reviews/phase-2-review-brief.md`, Cloud Opus + Astra) and
   reconcile. Note for the gate: the real desktop worker never writes conflict markers (harness models a stricter case).
3. After P3-A merges: owner does G2 with `docs/deploy.md` (owner has a Cloudflare account); Lead deploys and verifies
   read-only against the live vault; then milestone 2 canary (G3).
4. T1 Today: domain rule (Astra), layout (P4-B), Active Work Now card (P4-D after P4-A).

## Desktop sync worker broken — see `docs/plan.md` "Done" (root cause, fix proposal); awaiting owner approval to change the vault.

## T1 Today — decided 2026-09-25 (ADR-0012), provisional; implementation split per `docs/plan.md`.
