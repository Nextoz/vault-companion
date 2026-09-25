# Handoff — P4-B client correctness (`agent/client-correctness`)

Brief: `docs/briefs/P4B-client-correctness.md` plus Lead addenda 1 (write-blocked task list), 2 (ADR-0012 Overdue
placement) and 3 (Overdue count always visible; discard ≠ resolved). Scope: `apps/web` only. No contract, kernel,
worker, docs or service-worker change. Base: `origin/main` `e37dc83` (main was **not** merged; ADR-0012 read from
`origin/main` `abb816c`).

## Completed

1. **Duplicate-task identity** (`src/view.ts`)
   - Regression test first: two open tasks, identical `lineText`, lines 10/12, pending `CompleteTask` for 10. It
     **failed on `main`** (0 open rows) and passes now (row 12 stays).
   - An action belongs to the row its **envelope's locator** names, never "the task with this text". `resolve()` uses
     the server rule (vault-contract §3). Exact blob + index + text wins. Otherwise a single identical line counts only
     if `occurrencesAtRead == 1`, else the result is ambiguous. **When it's ambiguous the action gets its own row and no
     task is hidden** (pending completion → own Done today row; ambiguous refusal → own open row; live Undo → own
     re-opened row).
   - `occurrenceKey(locator) = blob:index:text` is the queue `taskKey` (per-task FIFO) and the tap-guard key. Undo
     uses its completion's key. The view derives identity from envelopes, so pre-P4-B items (text keys) still resolve.
   - Done today pairs a done line with a completion receipt **only when both are unique by text**. Otherwise no row
     claims a receipt, so there is no guessed Undo.
   - Covered: pending, acknowledged, stale read (desktop edit shifted lines, new blob), refusal, Undo, legacy keys and
     reload (e2e), and the remaining twin still completable after the first. The e2e test checks the two
     `CompleteTask`s carry `lineIndex` 10 and 12.
2. **Session/task read errors** (`src/api.ts`, `src/connection.ts`)
   - `getJson` aborts after `READ_TIMEOUT_MS = 10 s`, covering headers **and** body (raced against the abort). A
     timeout reads as `error`.
   - `wake()` is extracted and handles every outcome exhaustively (`satisfies never`). `ok` → kick + read;
     `signed-out` → its own banner; `offline`/`error` → one banner, "Couldn't reach your vault… **Try again**". The
     offline variant adds that captures are kept on the device.
3. **Conflict next step** (`src/ui/ActionsPanel.tsx`)
   - `conflict:task-changed` shows "This task changed on another device." plus **Refresh tasks**, **Copy text** (the
     existing export, renamed) and **Discard**.
   - Retry is shown only when `canRetry`: not for refusals known not to have applied (`knownNotApplied`: `refused:*`,
     `conflict:*`, `operation-id-reused`, `invalid`, account mismatch). The one exception is **`refused:vault-conflict`**:
     the same bytes can apply once the owner resolves the conflict on the desktop.
   - Refresh, then complete the current row: 2 taps.
4. **Undo beyond the toast**: Done today rows get **Undo** for a saved app completion when all of these hold:
   - the device still holds its receipt;
   - it is the latest action on that occurrence;
   - `item.accountKey` equals the session's account (new `QueueItem.accountKey` field);
   - the list isn't write-blocked.

   It reuses `undoCompletion` with the stored envelope verbatim. A guard in `App.undo` stops the toast and the row
   from minting a second Undo. The 8 s toast is kept.
5. **Addendum 1: write-blocked task list** (`src/writeBlock.ts`)
   - `refused:vault-conflict` shows the alert "Your task list has a sync conflict — resolve it in Obsidian on your
     computer." first. Other blocks show the server message.
   - No completion, no Undo (row or toast), no task capture: the Task toggle is disabled and the sheet falls back to
     Note without changing the remembered choice. Note capture still works.
   - Marker-region lines: the response does not say which lines lie between the markers, so under a conflict **every**
     listed task is shown frozen (muted, no controls) with a note that the list may include both sides.
6. **Addendum 2: ADR-0012**: Today comes first; **Overdue** is its own group below it, collapsed by default behind a
   toggle labelled with its count ("3 overdue"). The server's `todayTasks`/`overdue` membership is unchanged. The mock
   now fills `overdue` with `📅 < today` tasks.
7. **Addendum 3**
   - (a) The count is the toggle's label, so it is visible collapsed and expanded (e2e asserts both).
   - (b) Discarding a task action shows "Discarding removes only this action; the task will still need attention."
     The discarded completion then leaves "Not completed — this task still needs attention." on its row, or its own
     banner when ambiguous. The note clears when **a read of another revision** no longer has the task open at that
     locator, or when **the user redoes the action** on that row (`src/attention.ts`).
   - Discarding a **capture** first opens a dialog that shows its text with Copy / Discard / Keep, so nothing typed is
     lost unseen.
8. **Addendum 4: clock-skew**: no Retry (the stored envelope keeps its `occurredAt`, so identical bytes are refused
   again). The next step reads "Check your phone's date and time, then redo the action." Copy text and Discard stay.
   Unit test (`canRetry`, `attentionText`) and e2e (no Retry, no automatic re-send).
9. **CodeRabbit (PR #9)**: `refused:vault-conflict` keeps Retry, but not for task-list actions (complete, Undo, task
   capture) while the read on screen still has `writeBlock`, where it would only be refused again. Retry returns
   after a fresh unblocked read. Notes are unaffected.

## Important discoveries

- The container had no git remote (cloned from an empty seed bundle). I added
  `origin = https://github.com/Nextoz/vault-companion.git`. The first push was refused by the git proxy (repo not
  in the session's authorized set). After the owner attached the repo with push access, the branch was pushed.
- **WebKit could not be installed** (proxy 403 to `cdn.playwright.dev` / `playwright.download.prss.microsoft.com`).
  The e2e suite ran on the pre-installed **Chromium** with the iPhone 15 profile, using a git-excluded scratch config
  that overrides only the browser. CI's WebKit run is the first WebKit verification.
- The Worker gives no line ranges for conflict markers. The client therefore freezes the whole list during a conflict
  instead of the marker lines only.
- Reloading while a request is in flight leaves that item "Saving…" until the 60 s lease expires (existing A3 design,
  not changed). The twin e2e test reloads while offline for that reason.
- The discarded-refusal note is kept in memory only (**accepted by the Lead**, addendum 4). After a reload the task
  just shows open, which is the honest state. Persisting it would need an IndexedDB schema change in the queue.
- The per-occurrence FIFO key includes the blob, so actions minted from different reads of the same line are no
  longer serialised by the queue. Ordering there relies on the server's locator check (a second completion of an
  already-completed line is refused) and on the Undo dependency (`dependsOn`), which is unchanged.

## Recommend

- **Worker/contract (outside P4-B):** flag lines inside conflict markers, e.g. `readOnlyReason: 'refused:vault-conflict'`
  per task, or marker line ranges in `writeBlock`. The client could then freeze only those rows.
- If observed use shows the discarded-refusal note should survive reloads, persist it in IndexedDB.
- Possible merge overlap: P4-C (draft recovery) also touches `CaptureSheet.tsx` (this branch adds a `taskBlocked`
  prop), and P2-B may touch the offline banner copy.

## Verification

- `pnpm check` (lint + typecheck + test): **green**, 33 files, 487 tests.
- Web e2e: `vite build` + Playwright, **26/26 green on Chromium** (iPhone 15 profile) after the PR #9 fix; stable under
  `--repeat-each 5` (before addendum 3) and `--repeat-each 3` (after addendum 3). WebKit not run locally (see above).
- **Guards broken once, each confirmed to fail its test (then restored):**

  | # | Mutation | Caught by |
  |---|---|---|
  | M1 | `resolve` matches by text only (old identity) | view tests (12 fail) |
  | M2 | ambiguous locator treated as first match | view tests (3) |
  | M3 | `occurrenceKey` drops `lineIndex` | occurrenceKey test |
  | M4 | Done today Undo ignores account | view test |
  | M5 | Done today Undo ignores `writeBlock` | view test |
  | M6 | Done today pairs ambiguous receipts | view test |
  | M7 | read timeout timer does not abort | api tests (2) |
  | M8 | body not bounded by the timeout | api body test |
  | M9 | `wake` ignores session `error` | connection test |
  | M10 | Retry offered for every attention item | ActionsPanel test |
  | M11 | conflict line shows server message | ActionsPanel test |
  | M12 | conflict banner shows server message | writeBlock test |
  | M13 | same-revision read settles a discarded refusal | attention test |
  | M14 | redo on another task settles it | attention test |
  | M15 | Retry offered for `clock-skew` | ActionsPanel test + e2e clock-skew |
  | M16 | Retry offered for a task-list action while the read is write-blocked (CodeRabbit, PR #9) | ActionsPanel test + e2e vault-conflict Retry |
  | E1 | write-blocked rows stay completable | e2e sync-conflict |
  | E2 | task capture not blocked | e2e sync-conflict |
  | E3 | Overdue expanded by default | e2e ADR-0012 |
  | E4 | Retry button for all attention items | e2e changed-task refusal |
  | E5 | Done today without Undo handler | e2e Undo after toast expired |
  | E7 | session error left at "Loading…" | e2e read errors |
  | E8 | discard records no note | e2e discard ≠ resolved |
  | E9 | capture discarded without showing text | e2e refused capture |

  **Not isolated:** E6, the tap guard keyed by text instead of occurrence. That guard only lives while the envelope is
  being persisted (milliseconds), and the checkbox is also disabled synchronously, so no test fails when it is broken.
  The same applies to the App-level double-Undo guard (defence in depth behind the synchronous button disable).

## Commit

Branch `agent/client-correctness` on `origin/main` `e37dc83`: `01617d1`, `b6b0514`, `f6e200e`, `fe42398`, `37f3412`,
`0701638`, plus the handoff commits. Pushed to `origin/agent/client-correctness`.
