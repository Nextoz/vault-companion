# ADR-0048 — Calendar write credential (separate client, `calendar.events` only)
Status: accepted (Lead, 2026-10-03, on the owner's instruction). Credential and day-0 check only; the feature
("Calendar colours + add to Calendar from the app", Ideas Backlog) is not Ready and is not built by this ADR.
Extends ADR-0044 (read-only). High-risk: any code that uses this credential is reviewed with `-Reviewer both`.
## Context
The owner wants the Worker to create and colour Google Calendar events itself (route 2 in the idea). ADR-0044's token
is `calendar.readonly` + `gmail.metadata` and must stay unable to write.
## Decision
- **A second OAuth client, `calendar-writer`, owned by the owner, with exactly the scope `calendar.events`.** Never
  `calendar` (full: it can create and delete calendars and change sharing) and never added to the read-only client.
  Revoking either client does not affect the other. Mail access stays read-only metadata and is not reachable here.
- **Secrets (Worker only, plus the owner's password manager):** `GOOGLE_CAL_WRITE_CLIENT_ID`,
  `GOOGLE_CAL_WRITE_CLIENT_SECRET`, `GOOGLE_CAL_WRITE_REFRESH_TOKEN`. The names stay as the owner set them. The access
  token lives in memory for one request and is never stored, logged or returned by a route.
- **One calendar:** the owner's primary calendar only (`calendars/primary/events`); no calendar id from client input,
  no calendar creation, no ACL calls. Allowed calls when built: `events.insert`, `events.patch` (colour, title, time),
  `events.delete`, only for events the Worker created (tracked by an extended property `vcOperationId`).
- **Spike before building:** `tools/google-token-spike-write.ps1` (owner runs it) refreshes, asserts the granted scope
  is exactly `calendar.events` and no refresh-token expiry (client In production), creates one far-future test event,
  deletes it, and confirms it is gone. Prints status codes only. Day 0 PASS gates building; re-run on or after day 8.
- **Write rules when the feature is built:** it follows the app's write contract (operation ID, dedupe via the
  extended property before insert, no retry storm: one attempt per request, typed `google-reauth-needed` on
  `invalid_grant`). Event text comes only from the user's own action in the app; no task or note text in logs.
- **Failure/unset:** any secret unset => the feature is hidden/refuses with a typed `calendar-write-unavailable`;
  nothing else is affected.
- **Revocation:** remove `calendar-writer` at `myaccount.google.com/permissions` and delete the three secrets.
## Alternatives
- Widen the read-only client to `calendar.events`: one leaked token could then write; rejected.
- Vault intent line + PC scout writes the event: slower, needs the PC; owner chose direct (route 2).
- Full `calendar` scope: far more power than needed; rejected.
## Consequences
A leaked write token can create, edit and delete events on the owner's calendars until revoked, but cannot read mail or
change calendar settings. Treated like the ADR-0044 token: never in the repo, logs, Jev or other-vendor prompts.
