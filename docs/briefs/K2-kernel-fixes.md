# Brief K2 — kernel fixes from the Phase 1 gate

Type: **implementation**. Branch `agent/kernel-fixes`, worktree `C:\Dev\vault-companion-worktrees\kernel-fixes`.

## Objective

Fix the kernel findings assigned to **K2** in `docs/reviews/phase-1-reconciliation.md`: A1/R1 (kernel part), A5/R2,
R6, R7, R13, R14. Normative text: `docs/vault-contract.md` §4.1, §4.2, §4.4 (amended 2026-09-25). The reviewers'
concrete inputs are in `docs/reviews/phase-1-review-opus.md` (R-ids) and `docs/reviews/phase-1-review-astra.md`
(A-ids): turn **each one into a failing test first**, then fix.

Specifics:
- R1/A1: the exact inverse accepts a candidate only if re-completing it reproduces the whole effect (deep-equal,
  including `completedInPlace`, `removedAt`, `blockLineCount`) and it is the unique such candidate; else fall through
  to the semantic inverse. Add goldens "Done above Open" (LF, CRLF, no final newline, BOM) and a **property test**:
  for generated documents, `exactUndo(complete(d)) === d` or the kernel declines (never a wrong result).
- R2/A5: no-adoption rule and block-length invariants in `verifiedUndo` (all other tasks' block lengths unchanged;
  restored task has exactly its completed block's children). Goldens for "anchor gained children" and "indented line
  after heading anchor".
- R7: add `blankInserted: boolean` to `CompleteEffect` (in `api.ts` — allowed for this field only) and remove the
  residue per §4.2. R6: typed `refused:structure` instead of throwing (Done insertion inside an unclosed fence;
  anchors only on visible lines). R13: trim only `[ \t]`. R14: capture refused before a non-list first Open line.
- Keep every existing test green; do not weaken assertions.

## May change

`packages/vault-markdown/**`, `packages/test-vault/**`, `docs/briefs/K2-report.md`.

## Must not change

Everything else (the Lead is changing `packages/domain`, `packages/github`, `apps/worker` in parallel). If
`CompleteEffect` changes break `packages/domain` typechecking, say so in the report instead of editing domain.

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test` green (report any domain type error caused by the effect change).
Mutation-check each new guard (break it, see a test fail, restore). Commit on `agent/kernel-fixes`.

## Report

`docs/briefs/K2-report.md` (fixes, tests added, property-test size, mutation results). Final line:
`K2 DONE <commit-sha> — docs/briefs/K2-report.md`.
