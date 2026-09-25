# Brief F3 — queue/view fixes from the Phase 1 gate rerun

Type: **implementation**. Branch `agent/queue-rerun-fixes`, worktree `C:\Dev\vault-companion-worktrees\queue-rerun-fixes`.

## Objective

Fix the F3 rows of the rerun table in `docs/reviews/phase-1-reconciliation.md`. Reproductions:
`docs/reviews/phase-1-rereview-astra.md` (N2, N3) and `docs/reviews/phase-1-rereview-opus.md` (N5). Write **each as a
failing test first** (two independent queues over one fake-indexeddb database where the brief says tabs):

- **N2 (Astra)** — predecessor Retry while its dependent Undo's request is in flight: the dependent's late refusal must not
  become final. Suggested design: a persisted dependency generation bumped by `retry(predecessor)`; a dependent's refusal
  from an older generation re-queues it behind the predecessor instead of settling to attention. Envelope bytes never
  change. Test with held responses across two queues and lease expiry/reclaim.
- **N3 (Astra)** — acknowledged receipt vs a late stale read: responses must not regress the rendered state. Suggested:
  read generations (ignore a response older than the newest applied one) and reflection tied to the `known` map of the
  response being rendered, not a sticky `acknowledged` flag; acknowledgement only permits eviction. Test
  R0 → C → R1 (acknowledges) → late R0, plus a reload variant.
- **N5 (Opus)** — `postCommand` has no timeout: use `AbortSignal.timeout(T)` with `T` < lease (e.g. 30 s vs 60 s);
  classify abort/timeout as `retry`; the tab keeps flushing later items. Test a never-settling fetch.

## May change

`apps/web/**`, `docs/briefs/F3-report.md`.

## Must not change

Everything else (the Lead changes packages and the Worker in parallel). The wire contract is unchanged.

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @vault-companion/web e2e` green. Mutation-check each new guard.
Commit on `agent/queue-rerun-fixes`.

## Report

`docs/briefs/F3-report.md`. Final line: `F3 DONE <commit-sha> — docs/briefs/F3-report.md`.
