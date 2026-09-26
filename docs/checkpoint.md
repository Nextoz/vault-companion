# Checkpoint — 2026-09-25 (Milestone 1: integrated first-release build)

**HEAD:** `main`, clean. CI (GitHub Actions) gates every PR. Plan, milestones, workers, targets: `docs/plan.md`.

## In flight

Merged: PRs #1–#12 (CI, harness, Today rule, fixtures, offline SW, linked notes, client correctness, drafts, deploy).
Cloud: P4-D Active Work Now (`agent/active-work-now`, P4-A session) and P4-E token Undo (`agent/token-undo`, P4-B
session). Watcher: `tools/wait-for-work.sh` in the background.

## Exact next actions

1. P4-D and P4-E: PR → CodeRabbit → CI → handoff dispositions → merge (P4-E: Astra high review — identity/concurrency).
2. Then the whole-system review of the combined build (`docs/reviews/phase-2-review-brief.md`, Cloud Opus + Astra high).
3. Owner G2 now possible with `docs/deploy.md` §1–§7 (skip §0: P1 on hold, token Undo fits Free). Lead then runs §8–§9.
4. Canary (G3) needs the desktop sync worker patch applied first.

## Desktop sync worker broken — canary dependency. Tested patch ready (Lead scratchpad `syncfix/`); awaiting owner approval to apply to the vault.

## T1 Today — decided 2026-09-25 (ADR-0012), provisional; implementation split per `docs/plan.md`.
