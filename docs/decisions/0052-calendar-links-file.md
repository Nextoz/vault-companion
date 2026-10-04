# ADR-0052 — Calendar links file (`Automation/Calendar Links.json`)
Status: accepted (Lead, 2026-10-04). Implements ADR-0048's "remember the link" requirement.
## Context
The Worker can create/delete Google Calendar events, but the vault needs the event id to remove or expose it later.
Putting a Google event id in the To-Do or Active Work note would clutter the task line and couple two sources of truth.
## Decision
- **One derived file:** `Automation/Calendar Links.json`, schema 1:
  `{schema:1, links:{<itemKey>:{eventId, operationId, createdAt}}}`. It is the only vault state the calendar feature
  mutates.
- **One writer:** the Worker. The file is created and updated only through the existing vault write path: pinned HEAD,
  CAS against that HEAD (which proves the read blob is still current), commit trailers, and content dedupe before write.
  On a HEAD/CAS conflict the worker re-reads once and retries; no further storm.
- **Per-item ids only on read:** `GET /api/calendar/links` returns `{revision, links:{itemKey:eventId}}`, never
  operation IDs or timestamps. Mutations use the same operation ID as the Google operation for end-to-end dedupe.
- **Stable minimal serialisation:** parsed link objects keep their existing order; a write replaces only the named
  `itemKey` (new keys append, remove drops only that key). Serialisation is two-space indented, one trailing newline.
- **No text/ID clutter in task notes:** the task/Active Work note is never edited by this feature.
## Alternatives
- Store the event id in task-line metadata: couples calendar state to markdown edits and creates noisy diffs; rejected.
- A separate links table outside the vault: adds a second durable store and sync story; rejected.
- Use Google's own event search as the link of record: loses the operation-id/created-at audit trail and makes reads
  depend on the Google token; rejected.
## Consequences
The links file is derived and can be rebuilt by re-running the same operation after an event insert (Google list
dedupe by `vcOperationId` makes that safe). If the file is edited by hand, a failed parse is a typed `invalid`, never a
guess. One writer plus CAS prevents the Worker and any future calendar writer from racing.
