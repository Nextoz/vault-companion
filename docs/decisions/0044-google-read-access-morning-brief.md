# ADR-0044 — Read-only Google access for the Morning Brief (MB0)
Status: accepted (Lead, 2026-10-02, under the owner's MB backlog item; high-risk review `-Reviewer both`). Adds the
Worker's first outbound credential to a third party holding private data (Gmail, Calendar).
## Context
Morning Brief v2 runs as a Worker cron (owner: not on the PC) and must read today's calendar and the mail that needs
the owner. Google offers no service account for a personal Gmail; the only route is the owner's own OAuth client.
## Decision
- **One OAuth client owned by the owner**, Google project `vault-companion-brief`, consent screen External and
  **In production** (unverified, personal use). Scopes exactly `gmail.metadata` + `calendar.readonly`; no send,
  modify, or contacts scope. `gmail.metadata` forbids Gmail search (`q`) and returns only sender/subject/date/labels,
  so the Worker filters locally. The Worker refuses to start a gather if the token response reports any other scope.
- **Secrets:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` exist only as Worker secrets and in
  the owner's password manager. The access token lives in memory for one cron run; it is never stored, logged or
  returned by any route. Any secret unset ⇒ the brief runs without mail and calendar (typed `google-unavailable`
  reason), nothing else fails.
- **Spike before building (owner rule):** Google expires refresh tokens after 7 days while a client is in "Testing".
  The Lead verifies on the real account with `tools/google-token-spike.ps1` (run by the owner; prints only status
  codes, granted scopes and token lifetime fields, never values): day 0 a refresh succeeds with exactly the two scopes
  and no `refresh_token_expires_in`; day 8 (2026-10-10 or later) the same token still refreshes. MB0 code may be built
  after day 0; MB is not "done" until day 8 passes.
- **Data minimisation (ER mail rules):** the `gmail.metadata` scope reads metadata only (`format=metadata`: From,
  Subject, Date, labels) and forbids `q`; the Worker never requests or persists bodies. It fetches the label list and
  filters locally, dropping automated senders (GitHub, CodeRabbit, newsletters, `List-Unsubscribe`) before anything
  else sees them. Calendar keeps title, start, end, all-day flag.
  Only these fields reach the writer model (Scaleway EU, per the MB provider decision) and the brief JSON.
  No mail or calendar text in logs, errors, fixtures or commits (fixtures are synthetic).
- **Failure:** 400 `invalid_grant` (revoked/expired) ⇒ typed `google-reauth-needed` in the brief and the Status
  sheet, no retry storm (one attempt per cron run).
- **Revocation:** owner removes the app at `myaccount.google.com/permissions` and deletes the three secrets.
## Alternatives
- Keep the PC digest (it already reads Gmail locally): the PC is unreliable; owner chose the Worker. Rejected.
- "Testing" consent screen: token dies every 7 days. Rejected.
- Google Apps Script pushing a summary to the Worker: a second runtime and a second auth path to maintain. Rejected.
- Full `gmail.readonly` bodies (and `q` search) for better "why it needs me": violates the ER rule; metadata is
  enough. Rejected.
## Consequences
A leaked refresh token reads all of the owner's mail and calendars until revoked; it is therefore never in the repo,
logs, Jev or other-vendor prompts, and the routes that exist expose no way to read it back.
