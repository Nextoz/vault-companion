# Brief F — PWA shell, pending queue, first-release screens

Type: **implementation**. Branch `agent/frontend-shell`, worktree `C:\Dev\vault-companion-worktrees\frontend-shell`.

## Objective

Build `apps/web`: a small installable React + Vite PWA that talks only to the HTTP API defined by
`packages/contracts` (import types/schemas from `@vault-companion/contracts`; nothing else from the monorepo).

API (same origin):
- `GET /api/session` → `SessionResponse`; 401 ⇒ show "Signed out — reload to sign in" (Access handles login).
- `GET /api/tasks` → `TasksResponse`.
- `POST /api/commands` body `Command`; headers `Content-Type: application/json`, `X-VC-Request: 1`.
  200 `Receipt`; 409/422 `ApiError` (not retryable unless `retryable`); 503 retryable; 401 ⇒ keep item, show signed-out.

## Screens (docs/product-contract.md)

- **Today** (default): Overdue group, Today group, Done today. **All**: all open tasks. Tap a checkbox ⇒ complete.
- After completion: calm toast "Done · Undo" for 8 s; Undo sends `UndoCompleteTask` built from the receipt `effect`.
- **Capture** sheet: Task | Note toggle (remember last choice in localStorage), textarea, Save. Works offline.
- Every pending action shows its state: `On this device` → `Saving…` → `Saved to GitHub` | `Needs attention` (with
  message, Retry, Export text, Discard). Never claim desktop receipt.
- Tasks with `readOnlyReason` render without an active checkbox and with a short reason.
- Wikilinks in descriptions render as plain text for now (no note reading in this brief).
- Task text rendered as text nodes only — never `dangerouslySetInnerHTML`.

## Pending queue (docs/commands.md#client-pending-queue-pwa) — the critical part

IndexedDB `vault-companion` / store `pending`. Envelope created at the moment of the user action
(`operationId` = `crypto.randomUUID()`, `occurredAt` = now with local offset, `baseRevision` = revision of the
last TasksResponse). Retries reuse the identical stored envelope byte-for-byte. Items bound to `accountKey`;
never sent when the current session's accountKey differs. Backoff 1 s→60 s; retry on `online`, focus, start.
Retained until receipt or user Discard. `navigator.storage.persist()` requested. Logout is out of scope
(Access); but if `/api/session` returns a different accountKey, mismatched items show `Needs attention`.
Optimistic UI: a completed task moves to Done today immediately, marked `Saving…`; on refusal it moves back
with the error.

## PWA

Manifest (standalone, icons generated simple SVG→PNG or SVG), service worker caching **only** hashed static
assets + index.html (network-first for index.html); never `/api/*`. iPhone safe areas, 44 px touch targets,
`viewport-fit=cover`. No external fonts/scripts/analytics. System font stack. Keep styling plain CSS.

## May change

`apps/web/**`, root `tsconfig.json` reference for apps/web, root `package.json` devDependencies only if
needed for Playwright.

## Must not change

`packages/**`, `apps/worker/**`, `docs/**` (except your report).

## Tests you must write/run

Vitest (jsdom or happy-dom) for the queue: identical envelope on retry; account mismatch not sent; 409 stops
retry; 503 retries; receipt removes item; item survives a simulated reload (fake-indexeddb). Playwright WebKit,
iPhone 15 viewport, with `page.route` API mocks built from contract schemas: complete + Undo, capture offline then
online, attention state. `pnpm lint && pnpm typecheck && pnpm test` green.

## Report

`docs/reviews/F-report.md`; reply one line: `F DONE <commit-sha> — docs/reviews/F-report.md`.
