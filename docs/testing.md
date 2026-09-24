# Testing strategy

Evidence order: exact byte/golden diffs > real disposable Git > unit tests > model review.
Every test must name the production line whose breakage makes it fail; vacuous tests are removed.

## Layers

| Layer | Tool | Scope |
|---|---|---|
| Golden mutation | Vitest | `vault-markdown`: input fixture + command ⇒ exact expected bytes |
| Domain | Vitest | command handlers against `InMemoryStore` (CAS + trailer semantics identical to real) |
| Real Git | Vitest + git CLI | `LocalGitStore` against a temp bare repo; desktop clone scenarios |
| HTTP | Vitest + Hono `app.request` | auth, origin, validation, status codes, headers, log sentinel |
| UI | Playwright (WebKit, iPhone viewport) | Today/All/Done today, complete+Undo, captures, states, queue |
| Contract | Vitest | GitHub adapter against recorded real response shapes (`docs/discovery`) |

## Fixture requirements (synthetic, shape from real)

`packages/test-vault` must provide a To-Do List fixture family reproducing:
frontmatter with lists; prose paragraph before first heading; fenced ```` ```tasks ```` block containing
task-looking lines; instruction sections containing inline-code `- [ ]` examples; `## Open` with
blank-line-separated groups; completed `[x] … ✅` lines inside Open; `## Done` with italic note line,
newest-first items, blank-line groups, `❌ date reason` lines, `✅ date (trailing text)` lines, a mid-line
`❌`; trailing sections with a Markdown table containing emoji; wikilinks with aliases `[[a/b|c]]`;
Danish characters (æøå) and 4-byte emoji; LF variant **and** CRLF variant; no-final-newline variant;
duplicate identical task lines; a task with indented child lines and a blank line inside the block;
a `🔁` task; a `🆔` task; a task with fields `🔺 📅 ⏳ 🛫 ➕` in varied order; `⏫️` with U+FE0F.
All text invented ("Water the plants", "Call the bike shop").

## First-release acceptance tests (must pass before Phase 3)

A1 complete moves block Open→Done top, exact diff, CRLF+LF · A2 complete in-Open `[x]` stays untouched ·
A3 undo restores exact original bytes when nothing else changed · A4 undo after unrelated edits elsewhere
preserves them · A5 undo when completed line was edited ⇒ conflict, no write · A6 duplicate identical tasks:
exact line index resolves when blob unchanged; ambiguous ⇒ conflict when changed · A7 recurring ⇒ refused ·
A8 capture task appends after last non-blank Open line · A9 capture note: path, frontmatter, verbatim text,
collision ` (2)` · A10 lost response: retry returns `already-applied` with same commit, single commit in history ·
A11 double submit concurrently ⇒ one commit · A12 operation-id reuse with different payload ⇒ 409, no write ·
A13 stale base + concurrent edit to another task in same file ⇒ safe replay · A14 concurrent edit to the same
task ⇒ conflict · A15 concurrent edit to another file ⇒ applied · A16 Done today at 23:59/00:01 Copenhagen and
across DST changes (2026-10-25, 2027-03-28) · A17 occurredAt skew rejection · A18 log sentinel · A19 auth/origin
matrix · A20 path traversal corpus · A21 XSS corpus for linked-note rendering · A22 queue account binding ·
A23 upstream unavailable ⇒ 503 retryable, queue keeps item ·
A24 expired Access session while a draft exists ⇒ `signed-out`, queue paused, resumes after re-auth (F11) ·
A25 earlier attempt commits **between** dedupe and read ⇒ exactly one effect (F1) ·
A26 duplicate task twin completed on desktop before the command lands ⇒ `conflict:ambiguous` (F2) ·
A27 Undo while Complete is pending/unknown, and Undo sent before Complete ⇒ final state matches last user action (F4) ·
A28 Undo with a forged/altered target envelope ⇒ rejected by payload-hash check (F5) ·
A29 conflict markers in To-Do List ⇒ all writes `refused:vault-conflict` (F6) ·
A30 note capture where `Inbox/` has a case-variant name ⇒ ` (2)` (F7) ·
A31 capture text with lone `
`, U+2028, NUL; note `context` with `[[a|b]]`, `: `, quotes ⇒ file stays single-EOL, valid YAML (F8) ·
A32 findOperation unknown (truncated/non-ancestor base) ⇒ no write, `dedupe-unknown` (F9) ·
A33 read served at a revision not containing a receipt ⇒ client overlay, not authoritative open (F10) ·
A34 trailing block ID kept last after `✅`; `🏁` task refused (F13) · A35 duplicate `## Open`/`## Done`, subheading in Open ⇒ `refused:structure` (F14) ·
A36 app restart and server restart mid-retry ⇒ one effect · A37 task moved/edited on desktop; To-Do List missing ⇒ conflict / `refused:structure` ·
A38 write at 23:59:59 Copenhagen uploaded after midnight ⇒ date of `occurredAt` · A39 file > 1 MB ⇒ `refused:too-large` ·
A40 double-tap Save ⇒ one envelope (F19).

N/A by refusal in the first release (replaced by the refusal test A7/A34): recurrence successor generation,
unchanged/edited successor on Undo, duplicate `🆔` handling beyond read-only display.

GitHub adapter semantics were probed on the private sandbox (gate G1): `docs/discovery/github-api-probe-2026-09-24.md`.
Adapter tests replay the recorded bodies. Note: 409 also signals a branch **ref race** between PUTs to different
files; `InMemoryStore` does not model ref races (its writes are serialised), so the executor's handling of that
case is covered by the adapter mapping (409 ⇒ cas-mismatch) plus the executor's CAS-loss tests.

## Disposable end-to-end (Phase 2 gate)

Node-hosted worker + `LocalGitStore` → bare repo; desktop clone runs a worker-equivalent
(commit local → fetch → merge, conflict preserved). Scenarios: app→desktop, desktop→app, dirty desktop,
compatible divergence, same-task conflict, same-anchor append conflict (expected textual conflict,
both versions preserved), remote race, remote unavailable, lost response. Mocks alone do not pass.

## Canary evidence (Phase 3, human-gated)

Exact target file + expected unified diff; pre-canary commit SHA on GitHub and desktop; Drive backup
timestamp; rollback = `git revert <canary commit>` pushed by the owner (no history rewrite);
evidence after run: GitHub commit with trailers, desktop `git log`/file bytes after the real worker ran,
Obsidian Tasks still renders the task (screenshot by owner).
