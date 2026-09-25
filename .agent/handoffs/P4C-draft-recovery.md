# Handoff — P4-C capture draft recovery

Branch `agent/draft-recovery` (from `main` @ `51bbe33`).

## Completed

- **Draft store, separate from the queue.** `apps/web/src/queue/db.ts`: IndexedDB version 3 → 4 adds the `drafts` store
  (keyPath `accountKey`, one row per account: `{ accountKey, kind, text, updatedAt }`). The upgrade only creates
  missing stores, so `pending`, `receipts` and `meta` rows are kept. New `PendingStore` methods: `draft`, `putDraft`,
  `deleteDraft`, and `add(record, draftOf)`, which writes one pending record and deletes `draftOf`'s draft in **one
  transaction**.
- **Atomic Save.** `EnqueueOptions.clearDraft` (`queue.ts`): `#enqueueLocked` persists the new item through `add`, so
  the command is stored and the draft is deleted together, or neither is. Only Capture Save passes `clearDraft`.
  Nothing about claiming, sending, retrying or settling changed.
- **`apps/web/src/draft.ts` — `DraftKeeper`** (no React, unit-testable): `restore` (only the bound account's draft; a
  foreign row is ignored even if the store returned one), `change` (debounced 500 ms), `flush` (immediate), `discard`,
  `suspend` (Save is starting: cancels the debounce, blocks new writes, waits for writes already started), `resume`
  (Save failed), `dispose`. Changes made before `restore` answers are held so they cannot overwrite the draft being
  restored. Emptying the text deletes the draft. Any storage error calls `onUnavailable` and is swallowed. Typing is
  never blocked.
- **`CaptureSheet.tsx`**: restores text **and** capture type on open. Flushes on `visibilitychange`/`pagehide` and when
  the sheet closes. "Cancel" is now **Close**, which keeps the draft. A new **Discard draft** button appears while there
  is text. Save runs `suspend`, then `enqueue(..., { clearDraft: true })`; on failure it runs `resume`, and text plus
  draft stay. A quiet `muted small` notice appears when storage fails: "This draft cannot be kept on this device."
  Account change while the sheet is open: going from one account to a different one writes the pending text under the
  old account, clears the sheet, and shows only the new account's draft. Going from no account to the first confirmed
  account keeps what was typed and stores it under that account.
- `App.tsx`/`main.tsx`: the opened `PendingStore` is passed as `drafts`.
- Tests: `src/draft.test.ts` (15 tests), plus the v3 → v4 migration test in `src/queue/db.test.ts`. The new e2e spec
  `e2e/draft.spec.ts` has 2 tests:
  1. Type a Note → reload → reopen: same text, type restored as Note although the preference says Task → Save → mock
     API counts exactly 1 body and 1 applied → draft store empty → reopen is empty → reload re-sends nothing.
  2. Close keeps the draft, and Discard draft removes it.

## Important discoveries

- **No `origin` remote in this clone** (`git remote -v` is empty, and `gh` is not installed). **Nothing was pushed.**
  Both the early push and the final push failed with "'origin' does not appear to be a git repository". I did not
  guess a remote URL. The commits are local on `agent/draft-recovery`.
- **WebKit could not be installed.** The network policy rejects `cdn.playwright.dev` and
  `playwright.download.prss.microsoft.com`. I ran the whole e2e suite (8 existing + 2 new) on the preinstalled
  Chromium with the iPhone 15 device profile, using a temporary config that is not committed: **10/10 passed**.
  **The WebKit run is still outstanding** and must happen in CI or on the owner's machine.
- Known limitation (multi-tab): if tab 1 saves while tab 2 has the same account's sheet open with text, tab 2's next
  flush writes its text back as a draft. That is a new draft, not a resend: it becomes a command only on another
  explicit Save. Out of scope for "smallest".
- With no account ever confirmed on the device, nothing is kept, because the draft could not be attributed to an
  account. Capture already says "Connect once to set up this device".
- Restoring a draft's type does not change the remembered Task/Note preference.

## Recommend

- Run `pnpm --filter @vault-companion/web e2e` on WebKit (CI `ci:local`) before merging.
- Update `docs/security.md` (line ~40: "No vault content in IndexedDB except the user's own pending captures") and
  `docs/commands.md#client-pending-queue-pwa` to mention the `drafts` store. I did not change them because they are
  outside this brief's may-change list.
- Consider an ADR entry for the DB v4 schema if the lead considers it consequential.

## Verification

- `pnpm check` (lint + typecheck + test): **green**, 29 files, 470 tests.
- Web e2e, **Chromium** iPhone 15 profile (WebKit unavailable here): **10/10 passed**.
- Guard breaks: each guard was broken once, the relevant tests were run, and the code was reverted.

| # | Mutation | Result | Failing test(s) |
|---|---|---|---|
| G1 | `add()` does not delete the draft | caught | Save deletes the draft in the same transaction… |
| G2 | draft deleted in a separate transaction before the put | caught | a failed enqueue keeps the draft… |
| G3 | queue ignores `clearDraft` | caught | Save deletes the draft in the same transaction… |
| G4 | no debounce (write on every change) | caught | writes only after a pause…; after suspend… |
| G5 | drafts keyed per device, not per account | caught | 6 tests incl. account isolation |
| G6a | store read ignores the account key | caught | account isolation (store level) |
| G6b | keeper does not check the draft's account | caught | a store answering with another account's draft… |
| G7 | restore failure not caught | caught | storage failure |
| G8 | write failure not caught | caught | storage failure |
| G9 | `suspend` does not stop writes | caught | after suspend no pending or later change is written… |
| G10 | `suspend` does not wait for in-flight writes | caught | suspend waits for a draft write already started |
| G11 | changes before restore written early | caught | a change made before the draft is restored… |
| G12 | no DB version bump | caught | v3 → v4 migration |
| G13 | upgrade recreates existing stores | caught | v2 → v3 and v3 → v4 migrations |
| G14 | `resume` does not re-enable writes | caught | after suspend… resume follows the text again |
| UI | CaptureSheet Save without `clearDraft` | caught (e2e, Chromium) | draft.spec: survives a reload… sent exactly once |

The first G6 variant was too weak (it read an unused key) and passed. I added the two account-check tests above, and
the G6a/G6b rows are the rerun with those tests.

## Commit

`agent/draft-recovery`: `71ee936` (implementation + unit tests), `fb0562d` (e2e + account-check tests), then this
handoff commit. **Not pushed:** no remote is configured.
