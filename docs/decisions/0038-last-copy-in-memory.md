# ADR-0038 — Show the last copy of read-only screens, kept in memory only

**Status:** accepted by the Lead overnight (2026-10-02) under the owner's standing instruction; owner review pending.
Implements step 3 of the Ready Backlog "SP - App speed" ("show the last copy at once, then refresh"), first slice.

## Context

Tabs unmount when the owner switches away, so every return to Notes, a note or Training starts from "Loading…" and
waits for Worker → GitHub reads (SP2 made those cheaper; SP4 warms them). The backlog requires that the app "never
shows content older than the screen says" and that tasks only get this with their own review. The Notes screen also
promises that no note text is stored on the device except a queued edit.

## Decision

1. **Memory only.** The last successful answer per (account, screen) lives in a module-level map
   (`apps/web/src/lastCopy.ts`), at most 40 entries, oldest dropped first. Nothing is written to `localStorage`,
   IndexedDB or the service-worker cache; a reload or a closed app starts empty. (Jev: memory-only 1.0 over IndexedDB.)
2. **Scope: read-only screens** — the Notes list, one note, Training. Task reads, Today, Triage and the queue are
   untouched.
3. **Honest label.** While an earlier answer is shown the screen says `Showing the copy from HH:MM · refreshing…`;
   if the refresh fails it keeps the copy and says `Could not refresh · showing the copy from HH:MM`. A fresh answer
   replaces the copy and removes the label.
4. **A copy is never edited.** The note Edit button stays disabled until this read's answer arrives, so an edit's
   base blob SHA always comes from a fresh read (CAS still guards the write).
5. **Signed out drops every copy** of every account; copies are keyed by account, so another account never sees them.

## Consequences

- Returning to a tab or a note seen in this session is instant; first opens are unchanged.
- A failed refresh now keeps showing the last answer (labelled) instead of replacing it with an error.
- Persisting copies across app launches would need a new privacy decision; Progress/History and Dashboard can adopt
  `useLastCopy` in later slices.
