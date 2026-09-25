# P4-D Active Work Now — handoff

## Completed
- Contract `ActiveWorkResponse`: `ok {revision, blobSha, markdown}`, `absent {revision}`, or `refused` (`too-large` or
  `encoding`), plus `ACTIVE_WORK_PATH`.
- Domain `createActiveWorkService` (`packages/domain/src/active-work.ts`):
  - reads the fixed path at one pinned head;
  - reads only a regular file listed under `Tasks/`, and cross-checks the blob against the listing;
  - applies the 1 MB guard;
  - treats a missing file as `absent`;
  - maps an outage to a retryable `upstream-unavailable`.
- Worker: `GET /api/active-work` in `app.ts`, and composed in `index.ts`. Same Access auth and `no-store` as the other
  routes. Logs carry only route, status, commit and error code (`active-work:<code>`).
- Web: an "Active work" card at the top of Today, expanded by default. The collapse state is remembered per device
  (`prefs`). It uses the shared sanitised renderer (lazy-loaded), wikilinks show as plain text, and it re-reads when the
  task revision changes. Loading, error and refused states are one muted line; an absent file hides the card.

## Important discoveries
- The GitHub Contents API follows symlinks, as found in P4-A. A symlinked `Active Work Now.md` would otherwise serve
  another file. It is now read only if it is a regular file, and a symlink shows as `absent`.
- The production wiring test cannot reach 200 without GitHub. It asserts 503 (the store fails to mint a token with the
  fake key) instead of the 404 an unwired service gives, plus `no-store`.
- `apps/web/src/styles.css` was touched (card toggle styles). It is outside the brief's owned-file list.
- Cloud e2e ran on Chromium only; the container has no WebKit.

## Recommend
- Fix now: nothing blocking. Run the WebKit e2e in CI or locally.
- Follow-up: the card and `NoteView` each keep their own lazy renderer loader (a few lines each). Extract a shared
  loader when `NoteView` is next touched. Openable wikilinks in the card would need a resolution rule that is not in
  the contract.
- Leave alone: absent-as-state and the symlink-as-absent behaviour.

## Verification
- After merging the updated `agent/linked-notes` (which includes main's P4-B, P4-C and P2-A work): `pnpm check` is
  clean, 43 files, 711 tests passed, and web e2e passes 37/37 on Chromium (after linked-notes `37b0f1e`, which includes PR #7). Before that merge: 34 files, 589 tests passed.
- Web e2e (production build, iPhone 15 viewport, **Chromium** via a temporary uncommitted config): 11/11 passed,
  including two new Active work tests:
  - card above Today, XSS case inert, collapse survives a reload, nothing about the card in IndexedDB, Cache Storage or
    localStorage;
  - a 503 keeps the lists rendering with a quiet line, and an absent file shows no card.
- Mutations: 10 of 10 killed:
  - D1: 1 MB guard
  - D2: blob cross-check
  - D3: absent reported as an error
  - D4: truncated listing not caught
  - D5: outage mapping (killed by the domain test; at HTTP level the app's `onError` also returns 503)
  - D6: path in logs
  - D7: production wiring removed
  - D8: absent state shown as a message
  - D9: collapse not remembered (e2e)
  - D10: unsanitised insert (e2e)

## Commit
Branch `agent/active-work-now`, based on `agent/linked-notes` `37b0f1e` (already merged with main). See the final SHA
in the session's last line.
