# ADR-0014 — Capture drafts: per-account versioned store, Save in one transaction

**Status:** accepted (2026-09-25; implemented by P4-C, owner requirements on multi-window safety).

**Context.** The Build Contract requires minimal local draft recovery. Unsent text must survive closing, reload and
reauthentication, but must never become a second command, and several open app windows must not submit the same draft.

**Decision.** A separate IndexedDB store `drafts` keyed by `accountKey` holds `{ accountKey, id, version, kind, text, updatedAt }`.
Autosave writes only if the stored draft still has the `id` and `version` it started from and is not newer
(compare-and-set on `id` + `version` + not-older; `id` defeats a stale basis matching a draft recreated at version 1);
it never recreates a deleted draft. Save is one `readwrite` transaction over `drafts` and `pending`: verify the draft
`id` + `version`, enqueue the envelope, delete the draft. A window whose draft was superseded cannot save that basis. Drafts are
shown only to the account that wrote them; with no confirmed account nothing is kept.

**Consequences.** Exactly one submitter per draft; no resurrection after Save. Superseded windows must reopen Capture to
continue (follow-up: "Load latest draft"). Storage failure degrades to no draft, never blocks typing.
