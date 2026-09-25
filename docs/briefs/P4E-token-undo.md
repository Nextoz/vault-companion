# Brief P4-E — Token-based Undo (ADR-0013)

Type: implementation, identity/concurrency-critical. Branch `agent/token-undo` from current `main`.
Read `docs/decisions/0013-token-undo.md` first; it is the spec.

## Owned files

`packages/contracts/src/**` (Undo payload `targetCommit`), `packages/domain/src/{commands,execute,store}.ts` and
`testing/in-memory-store.ts`, `packages/github/src/{contents-store,local-git-store}.ts` + store contract tests,
`apps/web/src/{commands.ts,queue/**,ui/**}` (fill `targetCommit` from the receipt; persisted before first send),
`packages/e2e/src/**` (update Undo scenarios), `docs/commands.md` (Undo section only), handoff.

## Acceptance

- Undo makes **no paged scans**: one single-page compare `C...X` per attempt; > 1 page ⇒ `refused:undo-expired`.
- Tests (each shown to fail when its guard is broken): forged `targetCommit` (wrong op or payload hash) refused; token
  not an ancestor of head refused; lost-response retry of the Undo ⇒ `already-applied` with the same commit; second
  Undo of the same completion refused; `undo-expired` beyond one page (InMemoryStore page size configurable);
  exact-bytes inverse unchanged; semantic inverse after unrelated edits unchanged; client: Undo queued behind an
  unacknowledged completion gets `targetCommit` once and resends identical bytes after reload.
- **Call budget test:** count store/GitHub calls for one Undo attempt in the adapter tests (≤ 10) and assert Undo
  attempts ≤ 3.
- `pnpm check`, web e2e, `packages/e2e` green. No change to other commands' dedupe.

## Handoff

`.agent/handoffs/P4E-token-undo.md` (Completed / Important discoveries / Recommend / Verification / Commit).
Push early, push when done. Final line: `P4E DONE <sha>`.
