# Learning guide

For the owner: how to understand what is **implemented now**. Architecture docs say what the system must do;
this guide says where to look and what to be able to explain. Updated at major architecture changes only.
Last update: 2026-09-24 (Phase 1 in progress: domain executor done; Markdown kernel and PWA being built by workers).

## Suggested trace (read in this order)

`packages/contracts/src/index.ts` (the `Command` envelope) → `packages/domain/src/execute.ts` (`executeWrite`) →
`packages/domain/src/store.ts` (the port it calls) → `packages/domain/src/testing/in-memory-store.ts`
(`writeFile`, `findOperation`) → `packages/domain/src/execute.test.ts`, test **"A25/F1"**.
Follow one `CaptureTask` retry: where is the operation ID checked, which commit is read, what makes the second
write fail, and how the second call returns `already-applied`.

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

## Coming next (not yet implemented — sections will be added)

Markdown safety kernel (span splicing, locators) · Worker HTTP security layer (Access JWT, origin guard,
allowlisted logging) · PWA pending queue · disposable end-to-end Git round trip.
