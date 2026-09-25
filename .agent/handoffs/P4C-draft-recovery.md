# Handoff — P4-C capture draft recovery (incl. lead addendum: multi-instance safety)

Branch `agent/draft-recovery` (from `main` @ `51bbe33`).

## Completed

### Base brief

- **Draft store, separate from the queue.** `apps/web/src/queue/db.ts`: IndexedDB version 3 → 4 adds `drafts` (keyPath
  `accountKey`, one row per account). The upgrade only creates missing stores, so `pending`, `receipts` and `meta` rows
  are kept.
- **`CaptureSheet.tsx`**: restores text **and** capture type on open. Saves the draft after a 500 ms pause in typing,
  and at once on `visibilitychange`/`pagehide`/close. **Close** keeps the draft. **Discard draft** is an explicit button.
  Restoring or typing never enqueues or sends anything.
  - Account change while the sheet is open: going from one account to a different one writes the text under the old
    account, clears the sheet, and shows only the new account's draft. Going from no account to the first confirmed
    account keeps what was typed.
  - Storage failure shows a quiet notice, and typing and Save keep working.

### Addendum: several app instances

- **Draft identity and version.** A `Draft` is `{ accountKey, id, version, kind, text, updatedAt }`. Each keeper
  (`apps/web/src/draft.ts`) tracks the **basis**, i.e. the `{ id, version }` it last read or wrote, or `null` if it has
  seen no draft.
- **Guarded autosave and discard.** `putDraft(next, basis)` and `deleteDraft(accountKey, basis)` are each one readwrite
  IndexedDB transaction. The transaction reads the stored row, then writes only if `mayReplace` holds:
  - **G-CAS:** a non-null basis must still be the stored `id` and `version`.
  - **G-GONE:** a row that is gone stays gone. Only a `null` basis may create a draft (**G-CREATE**), and only when no
    row exists.
  - **G-NEWER:** a write with an older `updatedAt` than the stored row is refused. The keeper's own `updatedAt` never
    goes backwards (`max(now, last)`).
  - Keeper writes run one after another, so each write's basis is the result of the previous one.
- **Atomic Save (the "one submitter" rule).** `PendingStore.add(record, { accountKey, basis })` is one readwrite
  transaction over `pending` + `drafts`. It reads the draft and requires exactly `basis` (id **and** version). Only then
  does it put the pending record and delete the draft. Otherwise it writes nothing and answers `draft-conflict`.
  - `PendingQueue.enqueue` returns `'enqueued' | 'draft-conflict'` (`EnqueueOptions.draft`).
  - IndexedDB serialises readwrite transactions over overlapping stores. So of all instances holding a draft version,
    exactly one enqueues it, and this does not rely on Web Locks (the unit tests run with `locks: null`).
  - The sheet first `suspend`s its keeper, so writes already started finish and the basis is final. Then it saves with
    that basis.
  - A `null` basis means this text was never kept as a draft. Save then enqueues it without touching any draft that
    another instance keeps.
- **Keeper statuses and what the sheet shows:**
  - `kept`: no notice.
  - `unavailable`: "This draft cannot be kept on this device."
  - `elsewhere`: another instance created the draft first. "Another window is keeping a draft, so this text is not kept
    as a draft." Save still works for this new text.
  - `superseded`: the draft was changed, saved or discarded in another instance. The keeper stops writing, Save is
    disabled, and a refused Save shows "This draft was saved or changed in another window. Close and reopen Capture to
    continue." The text stays visible, and nothing is sent.
- Queue claiming, sending, retry and settling are unchanged. Only the enqueue transaction gained the draft check.

### Tests

- `src/draft.test.ts` has **27 tests**. Each "instance" is its own IndexedDB connection, queue, timers and clock over
  one shared database, with no Web Locks.
- The owner's three items:
  - **(1) Two instances, same draft:**
    - Both Save at once: `Promise.all`, exactly one `enqueued`, one `draft-conflict`, one command, no draft left.
    - Both Save in sequence.
    - Both edit: the first write wins, the other becomes `superseded` and its Save is refused. The command carries the
      winner's text.
  - **(2) Stale never overwrites newer:**
    - A matching version with an older `updatedAt` is refused.
    - An older basis is refused even when its clock is later.
    - An older basis is refused when its clock is earlier.
  - **(3) Autosave after Save:**
    - The same instance's own armed debounce fires after Save. This test does not call `suspend`, to prove the store
      refuses the write by itself.
    - The other instance's armed debounce, then its `pagehide`/dispose.
- Explicit interleavings, with both transactions created back to back before either runs:
  - autosave first, then Save: Save is refused and the newer draft stays;
  - Save first, then autosave: the draft stays gone and there is one command;
  - a write that tries to recreate a saved draft is refused.
- Also covered: discard in a stale instance does not delete the newer draft, two instances starting from no draft,
  debounce, restore, suspend/resume, account isolation, storage failure, and the v3 → v4 migration.
- `e2e/draft.spec.ts` has **3 tests**. The new one covers **two pages, same account**:
  1. Page 1 types a Note, and the draft is stored.
  2. Page 2 opens, restores the same draft, and saves it.
  3. Page 1's Save is refused by the store (notice shown, Save disabled).
  4. Page 1 keeps typing, waits past the debounce, fires `pagehide`, closes and reloads: **no draft is recreated**.
  5. **The mock API counts exactly 1 body and 1 applied `CaptureNote`.**

## Important discoveries

- **Not pushed.** This clone has **no `origin` remote** (`git remote -v` is empty, and `gh` is not installed). Every push
  attempt failed with "'origin' does not appear to be a git repository". I did not guess a URL. All commits are local
  on `agent/draft-recovery`.
- **WebKit unavailable.** Downloads from `cdn.playwright.dev` and `playwright.download.prss.microsoft.com` are rejected
  by the network policy. I retried after the addendum and it still failed. I ran the full e2e suite on the preinstalled
  Chromium with the iPhone 15 device profile, using a temporary config that is not committed: **11/11 passed**. **The
  WebKit run, including the two-page test, is still outstanding** and must happen in CI (`ci:local`) or on the owner's
  machine.
- A `superseded` window cannot save or keep its unsent edits. This is deliberate: the owner's rule is exactly one
  submitter per draft. Those edits stay visible in that window until it closes. Reopening Capture shows the current
  stored draft, if any.
- Some text is typed before the draft is restored. If the stored draft is the version this window just restored, the
  typed text replaces it (same basis). If another window had already changed the draft, the write is refused. It is
  never silent cross-window data loss.
- With no account ever confirmed on the device, nothing is kept, because the draft cannot be attributed to an account.
- Restoring a draft's type does not change the remembered Task/Note preference.

## Recommend

- Run `pnpm --filter @vault-companion/web e2e` on **WebKit** before merging.
- Update `docs/security.md` (~line 40: "No vault content in IndexedDB except the user's own pending captures") and
  `docs/commands.md#client-pending-queue-pwa` to describe the `drafts` store and the draft-checked enqueue. Both files
  are outside this brief's may-change list.
- ADR candidate: "Capture drafts: per-account CAS versioning; Save = one pending+drafts transaction."
- Optional UX follow-up: a "Load latest draft" button in a `superseded` window instead of close-and-reopen.

## Verification

- `pnpm check` (lint + typecheck + test): **green**, 29 files, **482 tests**.
- Web e2e on **Chromium**, iPhone 15 profile (WebKit unavailable here): **11/11 passed**.
- Proofs: each guard was broken once, the web unit tests (`apps/web/src`, 103 tests) were run, and the code was
  restored. Test names are shortened.

| Guard broken | Result | Failing tests |
|---|---|---|
| G-CAS: autosave ignores the basis version | caught | (1) both edit; (2) stale basis, later clock |
| G-NEWER: autosave ignores `updatedAt` | caught | (2) stale write, older updatedAt |
| G-GONE: autosave may recreate a deleted draft | caught | (3) own debounce after Save; (3) other instance's debounce; Save-then-autosave interleaving; resurrect refused |
| G-CREATE: a null basis may overwrite a draft | caught | two instances starting from no draft |
| G-SUBMIT: Save does not check the draft | caught | (1) Save at once; (1) Save in sequence; (1) both edit; (3) other instance; autosave-then-Save interleaving |
| G-SUBMIT-VERSION: Save checks id, not version | caught | (1) both edit; autosave-then-Save interleaving |
| G-ATOMIC: check, enqueue and delete in separate transactions | caught | (1) Save at once; Save-then-autosave interleaving |
| G-DELETE: Save does not delete the draft | caught | 9 tests (Save deletes; (1) ×3; (3) ×2; interleavings) |
| G-DISCARD-CAS: discard deletes whatever is stored | caught | discard in a stale instance |
| G-QUEUE: queue drops the draft basis | caught | 8 tests |
| G-QUEUE-RESULT: queue ignores `draft-conflict` | caught | (1) ×3; (3) other instance |
| K-BASIS: keeper does not advance its basis | caught | 7 tests |
| K-MONO: keeper's `updatedAt` may go backwards | caught | follows own versions; (2) stale write |
| K-SUPERSEDED: conflict not reported | caught | (3) ×2; (1) both edit; (2) earlier clock |
| K-DEBOUNCE: no debounce | caught | debounce; suspend; (3) ×2 |
| K-SUSPEND: suspend does not stop writes | caught | after suspend no write |
| K-SUSPEND-WAIT: suspend does not wait for started writes | caught | suspend waits for a started write |
| K-RESTORE-GATE: changes written before restore | caught | change before restore |
| K-ACCOUNT: keeper does not check the draft's account | caught | store answering with another account's draft |
| K-FAIL: write failure not caught | caught | storage failure |
| S-ACCOUNT: store read ignores the account key | caught | account isolation |
| S-MIGRATION: no version bump | caught | v3 → v4 migration |
| S-MIGRATION-KEEP: upgrade recreates existing stores | caught | v2 → v3 and v3 → v4 migrations |
| **e2e** UI-BASIS: the sheet saves without the draft basis | caught | draft.spec: reload + restore + once; **two windows** |
| **e2e** G-SUBMIT: the store does not check the version on Save | caught | draft.spec: **two windows** (the first window's Save was not refused) |

## Commit

`agent/draft-recovery`:
- `71ee936`: base implementation
- `fb0562d`: base e2e
- `902483a`: first handoff
- `012a0ce`: multi-instance CAS, the draft-checked atomic Save, and the tests
- then this handoff commit

**Not pushed:** no remote is configured.
