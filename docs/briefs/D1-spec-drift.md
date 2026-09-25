# Brief D1 — documentation drift from Phase 1 gate run 3 (Opus F6)

Type: **documentation** (bounded). Branch `agent/spec-drift`, worktree `C:\Dev\vault-companion-worktrees\spec-drift`.
Model: Codex GPT-6 Astra, reasoning effort **low**.

Update only these documents so they describe the behaviour that already exists in code (read the code; do not change it):

1. `docs/commands.md`:
   - The Undo algorithm: a completion can be undone once. The server searches `T..X` for a `Vault-Companion-Undoes:
     <target op>` trailer; if found ⇒ `conflict:task-changed`; if the search is inconclusive ⇒ `dedupe-unknown`. Undo
     commits carry that trailer. See `packages/domain/src/commands.ts`.
   - The write precondition `expect: 'absent' | 'regular-file'`: `precondition-failed` ⇒ `refused:structure`, never
     retried. See `packages/domain/src/store.ts` and `execute.ts`.
   - `MAX_TASK_LINE` (16,000): writes whose resulting line would exceed it ⇒ `invalid`; longer existing lines are
     omitted from reads and counted in `omittedLongLines`.
   - Client queue: `postCommand` 30 s timeout (`timeout` ⇒ retry), and the dependency generation bumped by `retry`
     (see `apps/web/src/queue/queue.ts`, `apps/web/src/api.ts`).
2. `docs/vault-contract.md` §4.2: add one sentence — a completion is undone at most once (Undoes trailer), and the
   accepted residual: a delayed app Undo can reopen an identical line that the desktop unchecked and another device
   completed again (text-equality semantics).
3. `docs/sync.md` "App write path invariants" and `docs/decisions/0005-idempotency-via-commit-trailers.md`: list the
   three trailers (`Vault-Companion-Op`, `Vault-Companion-Payload`, `Vault-Companion-Undoes`) and point to ADR-0011
   for head-CAS + precondition.

Keep edits short and factual; no new documents. May change only those four files.
Verify: `pnpm lint` passes (docs are excluded, so this is a sanity check only). Commit on `agent/spec-drift`.
Final line: `D1 DONE <commit-sha>`.
