# Learning guide

For the owner: how to understand what is **implemented now**. Architecture docs say what the system must do;
this guide says where to look and what to be able to explain. Updated at major architecture changes only.
Last update: 2026-09-25 (Phase 1 integrated: kernel, services, HTTP layer, PWA queue; gate review in progress).

## Suggested trace (read in this order)

`packages/contracts/src/index.ts` (the `Command` envelope) → `packages/domain/src/execute.ts` (`executeWrite`) →
`packages/domain/src/store.ts` (the port it calls) → `packages/domain/src/testing/in-memory-store.ts`
(`writeFile`, `findOperation`) → `packages/domain/src/execute.test.ts`, test **"A25/F1"**.
Follow one `CaptureTask` retry: where is the operation ID checked, which commit is read, what makes the second
write fail, and how the second call returns `already-applied`. Then follow a real completion end to end:
`apps/web/src/queue/queue.ts` (envelope stored before sending) → `apps/worker/src/app.ts` (`POST /api/commands`) →
`packages/domain/src/commands.ts` (`completePlan`) → `packages/vault-markdown/src/mutations.ts` (`completeTask`) →
`packages/domain/src/commands.test.ts` test **"A1"** (whole-file golden comparison).

## 1. Git is the database; writes are compare-and-swap commits

Every change is one commit that replaces one file only if the file's blob SHA is still what we read. Nothing
else stores personal data. Why: the vault must survive the app disappearing, and many tools edit it concurrently.

Files: `packages/domain/src/store.ts` · `packages/domain/src/testing/in-memory-store.ts` ·
`docs/decisions/0001-source-of-truth-and-write-endpoint.md` · `docs/sync.md`

Be able to answer: What does "Saved to GitHub" prove and not prove? Why is CAS on a *file blob* enough while other
files keep changing? What happens when the desktop edited the same file a second ago?

## 2. Idempotency without a database (operation ID + commit trailers)

The phone mints an operation ID once; every retry reuses it. Each commit carries `Vault-Companion-Op` and a
payload hash. Before writing, the server searches Git history for its own operation. Each attempt pins **one
commit X** for both the search and the read — the review's only Critical finding (F1) was about this.

Files: `packages/domain/src/execute.ts` · `packages/domain/src/payload-hash.ts` · `packages/domain/src/execute.test.ts` ·
`docs/commands.md` · `docs/reviews/phase-0-architecture-review.md` (F1)

Be able to answer: Why can't a lost HTTP response create a duplicate? Why is "unknown outcome" treated as
"go back and search" rather than "retry the PUT"? Why hash the raw body with JCS instead of the validated object?
What does `dedupe-unknown` protect against?

## 3. Pure core, replaceable edges

Domain and Markdown code are pure TypeScript with no React/HTTP/GitHub/Node imports — enforced by lint, not
convention. Adapters (GitHub, local Git, in-memory) implement one port.

Files: `eslint.config.js` · `docs/architecture.md` · `packages/vault-markdown/src/api.ts` · `packages/domain/src/paths.ts`

Be able to answer: What stops someone importing `hono` into domain code? Why does the same executor run on
Cloudflare Workers and in Node tests? Where is the only place a vault path is allowed to enter the system?

## 4. Time is a policy, not a device setting

Durable dates (`✅`, `➕`) are the Copenhagen calendar date of the moment the user acted, regardless of the phone's
zone or when the upload happened.

Files: `packages/domain/src/time.ts` · `packages/domain/src/time.test.ts` · `docs/vault-contract.md` §6

Be able to answer: A completion tapped at 23:58 and uploaded at 00:10 — which day is it done? What does travel to
New York change? Why are future timestamps rejected but old ones accepted?

## 5. Evidence over opinion

Behaviour is proven by tests that fail when the guard is removed (mutation-checked), real-Git spikes, and
fresh-context reviews — not by the author's confidence.

Files: `tools/spikes/git-sync-spike.sh` · `docs/discovery/phase-0-findings.md` · `docs/reviews/phase-0-reconciliation.md` ·
`docs/orchestration.md`

Be able to answer: Which real-Git result showed that phone and desktop captures will conflict (S5b)? Why was
a reviewer restarted rather than reused? Which line of `execute.ts` does the A25 test protect?

## 6. The Markdown kernel edits lines, not documents

The kernel never re-serialises a file. It finds the exact line span, splices it, then **re-parses its own output
and checks post-conditions** before returning, so a kernel bug refuses instead of writing. Tasks are parsed the way
Obsidian Tasks 8.0.0 does: fields only from the end of the line.

Files: `packages/vault-markdown/src/mutations.ts` · `packages/vault-markdown/src/fields.ts` ·
`packages/vault-markdown/src/text.ts` · `packages/test-vault/fixtures/lf/expected/` (hand-written goldens) ·
`docs/vault-contract.md`

Be able to answer: Why is `✅ 2026-09-11 (note)` not a done date? What does the locator do when the file changed
and the task text appears twice? How does Undo restore exact bytes, and when does it fall back to an anchor?
Why do phone captures go to the *top* of Open (ADR-0010)?

## 7. The HTTP boundary trusts nothing it did not check

The Worker verifies the Access JWT itself, accepts mutations only as same-origin JSON with a custom header, never
echoes submitted values, sets `no-store` + CSP on every response, and logs through a record type that has no field
for personal text. The production entry refuses to serve with incomplete configuration.

Files: `apps/worker/src/auth.ts` · `apps/worker/src/app.ts` · `apps/worker/src/log.ts` · `apps/worker/src/index.ts` ·
`apps/worker/src/app.test.ts` ("A18 log sentinel")

Be able to answer: What stops a malicious site from making your phone complete a task (CSRF)? Why does the Worker
verify the JWT even though Cloudflare Access already did? Why is a note's *path* sensitive in logs?

## 8. The phone keeps a small, honest queue

Every action is stored on the device **before** it is sent and is resent byte-for-byte until a receipt or a terminal
refusal. Items are bound to the signed-in identity. Undo waits for the completion it depends on. The UI only claims
"Saved to GitHub" with a receipt; it never claims the desktop has anything.

Files: `apps/web/src/queue/queue.ts` · `apps/web/src/queue/classify.ts` · `apps/web/src/api.ts` ·
`apps/web/src/queue/queue.test.ts` · `docs/commands.md` (client queue section)

Be able to answer: What happens to a capture typed offline when the session has expired? Why can't Undo simply
delete a pending completion that was already sent once? How does the app avoid showing a saved completion as open
again after a stale read?
