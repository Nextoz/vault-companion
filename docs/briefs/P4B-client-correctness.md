# Brief P4-B — Client correctness and phone recovery (independent review 2026-09-25)

Type: **implementation**, correctness-critical. Branch `agent/client-correctness`. **Claude Code Cloud** (Linux).
Scope is `apps/web` only. The server contract, kernel and refusal semantics do not change.

## 1. Duplicate-task identity (verified defect)

`apps/web/src/ui/App.tsx` (`taskKey = locator.lineText`, lines ~151/179) and `apps/web/src/view.ts` (`latest` keyed
by `lineText`, lines ~41–87) conflate two open tasks with identical text. Reproduction: `buildView` with two open tasks,
identical `lineText`, line indexes 10 and 12, plus one pending `CompleteTask` for index 10 ⇒ zero open rows and one
completed overlay (the index-12 task disappears).

- **First** add that regression test (must fail on current `main`).
- Identify the intended occurrence with the existing locator (`lineIndex` + `lineText` + read revision/blob) and the
  queued envelope's operation ID — across optimistic display, tap guards, per-task FIFO ordering and Undo. No task-ID
  migration, no `🆔` writes. The server still refuses ambiguous changes; the client must not guess either — if it
  cannot tell which row an action belongs to after a new read, show the action in its own pending row rather than
  hiding a task.
- Cover: pending, acknowledged, stale read (lines shifted by a desktop edit), refusal, Undo, reload, and the remaining
  identical task still completable after the first completes.

## 2. Session/task read errors (verified defect)

`wake()` in `App.tsx` handles only `ok` and `offline`; other session outcomes never reach the normal task-loading
error state. Give session and task reads a bounded wait (abort after a fixed timeout, e.g. 10 s) and one actionable
error state ("Couldn't reach your vault — Try again") reachable from every non-ok outcome. Test each outcome.

## 3. Conflict next step (contract gap)

For a `conflict:task-changed` (non-retryable) refusal, Retry repeats identical bytes and cannot succeed. Replace the
generic Retry with: a one-line explanation ("This task changed on another device"), **Refresh tasks** (re-read,
then the user can act on the current row), **Copy text** (existing export) and **Discard**. Keep Retry for retryable
failures only. Test that Retry is absent for non-retryable refusals.

## 4. Undo beyond the toast (contract gap: "Undo a completion safely")

Keep the 8 s toast, and add Undo on app-originated completions in **Done today** while the device still holds the
completion's receipt (same session/account), reusing the existing `undoCompletion` path and the stored envelope
verbatim. No Undo for completions the device did not make. Test: Undo from Done today after the toast expired sends
exactly one valid `UndoCompleteTask`.

## May change / must not change

May: `apps/web/src/**`, `apps/web/e2e/**` (add specs; do not restructure config), `docs/briefs/P4B-report.md`,
`.agent/handoffs/P4B-client-correctness.md`. Must not: other packages, contracts, docs, service-worker caching.

## Verify and hand off

`pnpm check` + web e2e green; each new guard broken once to prove its test fails (list them). Write the handoff
(`Completed / Important discoveries / Recommend / Verification / Commit`). **Push early**, then final push.
Final line: `P4B DONE <sha>`.
