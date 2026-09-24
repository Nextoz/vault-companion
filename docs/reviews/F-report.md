# Brief F report — PWA shell, pending queue, first-release screens

Branch `agent/frontend-shell`. Worker: Claude Opus 5.5. Date: 2026-09-24.

## Result

`apps/web`: React 19 + Vite 8 PWA that imports only `@vault-companion/contracts`. `pnpm lint && pnpm typecheck && pnpm test`
green (60 tests workspace-wide, 29 new in `apps/web`). Playwright WebKit / iPhone 15: 7/7 green
(`pnpm --filter @vault-companion/web e2e`).

## Files touched

- `apps/web/**` (new).
- Root `tsconfig.json`: reference to `apps/web`.
- `pnpm-lock.yaml`: new workspace package. This file is not on the brief's "may change" list, but adding the package
  requires the change.
- Root `package.json`: **unchanged**. `@playwright/test` is a devDependency of `apps/web` instead.
- Nothing under `packages/**`, `apps/worker/**`, or `docs/**` except this report.

## Layout

| File | Role |
|---|---|
| `src/queue/queue.ts` | `PendingQueue`: persistence-first enqueue, send loop, account binding, FIFO, dependencies, backoff, signed-out pause |
| `src/queue/db.ts` | IndexedDB `vault-companion` / store `pending`, key `operationId` |
| `src/queue/classify.ts` | Response → `receipt` / `attention` / `retry` / `signed-out`; `backoffMs` |
| `src/commands.ts` | Envelope minting (`schemaVersion: 1`, `crypto.randomUUID()`, `occurredAt` with local offset), validated by `Command.parse` before queueing |
| `src/view.ts` | Server read + optimistic overlay of queued actions → Overdue / Today / All / Done today |
| `src/api.ts` | `/api/session`, `/api/tasks?known=`, `/api/commands`; all `redirect: 'manual'` |
| `src/sw/{sw,policy}.ts` | Service worker; `vite.config.ts` builds it to `/sw.js` and injects the precache list |
| `src/ui/*` | App, TaskList, CaptureSheet, ActionsPanel (+ Export dialog), StateChip |
| `e2e/*` | Playwright specs + `MockApi` (every mocked response is parsed through the contract schema) |

## How the brief and `commands.md` are met

- **Identical envelope.** The stored record holds the request **body string**. Every attempt sends that string; it
  is never re-serialized. The record is persisted before the first send.
- **`everSent`.** Persisted *before* the fetch leaves (in `#claimNext`). `saving` is in-memory only, so after a
  reload an interrupted item comes back as `pending` with `everSent: true`.
- **Account binding.** Items carry the `accountKey` they were created under. Sending waits for a *confirmed*
  `/api/session`. A mismatch is derived, not persisted: the item shows `Needs attention` with Export/Discard and no
  Retry, and it recovers if the original account signs back in.
- **Signed out (F11).** An opaque redirect, a 401, a non-API 403 (Access), or the `unauthorized` code: the item is
  kept, the queue pauses, and a banner reads "Signed out — reload to sign in" with **Sign in again**, a top-level
  reload. On the next confirmed session the queue resumes under the account check. An API 403 (`forbidden`) is
  `attention`.
- **Errors.** Non-retryable ApiError (409/422/400/403) → `attention`. `retryable: true`, 5xx, 408, 429, network
  errors and malformed 200s → backoff (1 s doubling, capped at 60 s, no limit). Triggers: start, `online`, window
  focus and `visibilitychange` (`kick` skips the backoff wait), plus a timer for the earliest backoff.
- **Dependencies (F4).** Undo of a completion that was never sent removes both items locally and sends nothing.
  Otherwise the Undo is queued with `dependsOn` and is sent only after the completion has a receipt or reaches
  `attention` (a terminal refusal). Items sharing a task key go strictly FIFO, independently of `dependsOn`.
- **Undo payload.** `UndoCompleteTask.payload.target` is the stored CompleteTask envelope, verbatim, as
  `commands.md` specifies. The brief says "built from the receipt effect", but the reconciled contract takes
  precedence here.
- **Double tap (F19 / A40).** The checkbox disables itself synchronously in the click handler, and a ref guards the
  mint. Save in Capture uses a ref guard the same way.
- **Optimistic UI.** A completion moves to Done today immediately with its state chip. On refusal it moves back to
  its list, carrying the error. A saved completion keeps overlaying until `/api/tasks?known=<commit>` reports
  `included` (A33 overlay).
- **UI states.** `On this device` → `Saving…` → `Saved to GitHub` | `Needs attention` (message, Retry, Export text,
  Discard). Nothing claims the desktop has anything.
- **Rendering.** Task text is rendered only as React text nodes. There is no `dangerouslySetInnerHTML` or
  `innerHTML` anywhere (grep-clean), and an e2e test checks that an `<img onerror>` description stays inert.
  Wikilinks render as plain text (`[[a|b]]` → `b`).
- **Read-only tasks.** `readOnlyReason` → a dashed, inactive check plus a short reason (for example "Recurring —
  complete in Obsidian"). A `writeBlock` shows a banner and disables completion.
- **Capture.** Task | Note toggle remembered in `localStorage` (`vc.captureKind`). Works offline: the
  `baseRevision` and `accountKey` from the last successful read (`vc.lastRevision`, `vc.lastAccountKey`, both
  non-content) let an envelope be minted without a connection. A device that has never connected cannot capture and
  says so. Text is sent verbatim, never trimmed. A tap on the backdrop does not discard typed text.
- **Storage.** `navigator.storage.persist()` is requested, and the UI says "kept on this device while possible". If
  IndexedDB is unavailable the app says so instead of running without a queue.
- **PWA.** Manifest (standalone; PNG 192/512/180 generated by a dependency-free `scripts/gen-icons.mjs`, plus SVG).
  The service worker precaches `/` and hashed `/assets/*`: network-first for the shell (it only replaces the cached
  shell with a `basic`, non-redirected `text/html` 200, so an Access login page is never cached) and cache-first for
  assets. It never intercepts `/api/*`, including navigations. `viewport-fit=cover`, `env(safe-area-inset-*)`,
  44 px `min-height`/`min-width` targets, system font stack, plain CSS, light/dark. No external
  fonts/scripts/analytics. The production build adds a CSP `<meta>` (`default-src 'self'`, no inline script/style).

## Tests

Vitest (`fake-indexeddb`, fresh `IDBFactory` per test; injected clock/timer):

- `queue.test.ts` (16): identical bytes across network error → 503 → success, and stored before the first send;
  receipt removes the item; account mismatch never sent, then sent once the right account returns; no send before a
  session; 409 stops retrying until user Retry (same bytes); 503 retried after backoff and not before; backoff
  1 s → 60 s; 401 keeps the item and pauses, then resumes FIFO; Access 403 vs API 403; survives a simulated reload
  and resends identical bytes; Undo cancels a never-sent completion locally; Undo waits behind an ever-sent
  completion and carries it verbatim; `dependsOn` alone holds back a dependent; a dependent is released by a
  terminal refusal; strict per-task FIFO without a dependency; captures are not blocked by a backing-off task item.
- `view.test.ts` (5), `sw/policy.test.ts` (3), `time.test.ts` (3), `text.test.ts` (2).

**Mutation check (rule 7).** Each guard in `queue.ts` was broken in turn and the suite rerun. All of these were
caught: account check, attention auto-retry, altered body on retry, record kept after receipt, no local cancel,
dependency ignored, `everSent` not set, signed-out not pausing, backoff ignored, per-task FIFO ignored. Two mutants
survived the first pass (dependency, FIFO: each masked by the other). I added targeted tests, and both are now
killed. A third survivor, removing the `break` after signed-out, turned out to be redundant code: `#claimNext`
already stops. I re-targeted it at `#signedOut = true`, which is caught.

Playwright (WebKit, `devices['iPhone 15']`, production build via `vite preview`, `page.route` mocks):

1. Complete → Done today with "Saved to GitHub" → Undo; the server receives `UndoCompleteTask` whose
   `payload.target` deep-equals the CompleteTask; the task returns to Today.
2. Capture a note offline (`context.setOffline` + aborted route) → "On this device", nothing applied → back online
   → "Saved to GitHub"; all attempts had identical bytes; the Note choice is remembered.
3. Refused completion (409) → back in Today with "Needs attention" and the message; Export shows the task line;
   Discard clears it; no automatic retry.
4. A pending capture survives a page reload (real WebKit IndexedDB) and is sent afterwards with the identical body.
5. Read-only task: no button, reason shown. 6. XSS-looking description stays text; wikilinks are plain.
   7. Signed out: banner, nothing sent.

`serviceWorkers: 'block'` in e2e keeps `page.route` deterministic. The SW's own policy is unit-tested; its
install/offline-shell behaviour is **not** exercised end-to-end (see open points).

## Open points for the lead

1. **SW offline shell not e2e-tested.** The policy is unit-tested and the build asserts `sw.js` is a self-contained
   classic script with an injected manifest. A real-device check (airplane mode → reopen the installed app) belongs
   in the Phase 3 phone checklist.
2. **Bundle size.** 335 kB JS (102 kB gzip), most of it zod through the contract schemas. Acceptable for a PWA
   cached by the SW. `zod/mini` in contracts would be a lead decision (it touches `packages/**`).
3. **Multiple tabs.** Two open tabs may each send the same stored envelope. That is safe by server dedupe (identical
   payload hash), but it wastes requests. Web Locks could serialize them; not done.
4. **Recent receipts are memory-only** (at most 20). After a reload the F10 overlay for an already-saved completion
   is gone, and the next read is authoritative. `commands.md` allows persisting "recent receipts"; I left this out to
   keep the store to `pending` as the brief names it.
5. **Worker headers.** The CSP meta is defence in depth. The Worker should send CSP,
   `Cache-Control: no-store` on `/api/*`, and `no-cache` on `/` and `/sw.js`.
6. **Captured-task display.** Until the next read, a queued `CaptureTask` appears only in the Actions list, not in
   All tasks.
