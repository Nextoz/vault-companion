# SP1 — read-latency measurement (synthetic, pre-caching)

Owner-selected order: measure first (Ready Backlog SP, 2026-09-30). Read-only reconnaissance; **no caching
implemented and no response semantics changed**. All fixtures, delays and keys are synthetic; nothing was read
from or written to a vault.

## What was measured

`tools/sp-read-latency.mjs` builds the **production Worker composition**
(`apps/worker/src/index.ts` → `createProductionApp`, real store + services + auth) and puts a fake GitHub REST API
behind it. The fake counts every call by kind — `token` (installation, `/app/installations/*/access_tokens`),
`head` (`/git/ref/heads/<branch>`), `tree` (`/git/trees/*`), `blob` (`/contents/*`) — and adds a configurable
delay before each response, so time can be attributed to the endpoint the Worker actually calls.

`tools/sp-read-latency.test.ts` asserts the harness (see below). Cold = the first request on a brand-new app/store
(token, head and tree caches all empty). Repeat = the next requests on that same app.

### Measured (observable) vs inferred (unobservable)

- **Measured here:** `app.fetch()` wall time and the count/delay of the GitHub REST requests the Worker issues.
- **Not measured:** Cloudflare Access verification, edge→GitHub network RTT, TLS, and phone/client time. The numbers
  below are a *relative attribution of Worker+GitHub-call time on a synthetic server*; they are **not** phone or
  production latency and must not be reported as such.

## Evidence

Injected delays: `token=5 ms, head=30 ms, tree=20 ms, blob=10 ms`; 5 repeats per scenario.

| scenario | cold ms | cold reqs | repeat median ms | repeat reqs/call | injected delay/repeat |
| --- | --- | --- | --- | --- | --- |
| notes-list | 76.9 | token=1 head=1 tree=1 blob=0 | 46.7 | token=0 head=1 tree=0 blob=0 | 30 ms |
| note-read | 104.5 | token=1 head=1 tree=1 blob=1 | 62.1 | token=0 head=1 tree=0 blob=1 | 40 ms |
| active-work | 100.6 | token=1 head=1 tree=1 blob=1 | 59.0 | token=0 head=1 tree=0 blob=1 | 40 ms |
| training | 100.9 | token=1 head=1 tree=1 blob=1 | 60.6 | token=0 head=1 tree=0 blob=1 | 40 ms |
| scouts | 145.5 | token=1 head=1 tree=3 blob=0 | 46.0 | token=0 head=1 tree=0 blob=0 | 30 ms |
| history | 114.4 | token=1 head=1 tree=1 blob=2 | 77.9 | token=0 head=1 tree=0 blob=2 | 50 ms |

(Observed ≈ injected delay + ~15–25 ms of timer/promise overhead; the tests assert the *delta* between injected
configs, not absolute values.)

## Findings

1. **Every read starts with one mutable `head` lookup.** It is the only request no commit-addressed cache can
   answer, and it repeats on every read (repeat `head=1` in every row).
2. **Commit-addressed tree listings are already cached in the isolate.** `GitHubContentsStore.listings` is keyed by
   `(commit, dir, recursive)`; the repeat rows show `tree=0` while `head=1`. This is already a working
   immutable-by-revision cache.
3. **Blob reads are immutable per revision.** `contents/<path>?ref=<commit>` never changes for a given
   `(path, commit)`; the store does not cache them, but upstream they are content-addressed by `blobSha`.
4. **A cold note open is the heaviest read** (`head` + `tree` + `blob`; ~105 ms at these delays) and a cold list is
   `head` + `tree`.
5. **The Today tab composes several reads that each call `head`** (morning, active-work, triage, scouts, tasks). They
   run in parallel, so they duplicate the same ref request; that is pure avoidable cost with no freshness benefit.
6. **An absent scout-status directory costs 3 tree probes cold** (`Automation/Scout Status` 404 → parent
   `Automation` 404 → root tree) and is then cached as absent.
7. **The installation token is fetched once per isolate** (cold `token=1`, repeat `token=0`).

## Cache candidates and risks

Safe (immutable-by-revision, content/commit addressed):

- **Directory listings per `(commit, dir, recursive)`** — already implemented in-isolate.
- **Blobs per `(repo, blobSha)`** — immutable; only 1 MB per blob and already capped by `MAX_NOTE_BYTES`/1 MB guard.

Risky (mutable pointer):

- **`head`** — the branch tip moves on every write. Any caching trades freshness for calls.

Cross-cutting risks to respect for any of the above:

- **Account/repository binding** — keys must include owner, repo (and installation) so no tenant sees another's data.
- **Auth partitioning** — the Cloudflare Cache API is per-zone/colo and is **not** partitioned by an auth header; a
  shared cache entry for private vault bytes would be a cross-account leak. Prefer per-isolate memory for private
  content, or key explicitly by account/repo.
- **Memory / Cache API limits** — the store already drops its in-memory maps at `CACHE_LIMIT = 256` entries and caps
  files at 1 MB; any new cache needs an equivalent bound and fail-open behaviour.
- **Latest-head freshness** — a stale `head` makes every read and the dedupe window view an old revision. Any head
  cache must be short-lived and must never be the base of a write.

## Recommended next implementation (one, small)

**Memoize `head` for the read path only: single-flight + a short TTL (≤ 1500 ms), keyed by `(owner, repo, branch)`.
Writes keep today's uncached `head`.**

- Rationale: `head` is the dominant repeated cost and the Today tab duplicates it in parallel; a ≤1.5 s TTL caps the
  staleness window and coalescing removes the parallel duplicates without any new freshness window.
- Exact files: `packages/github/src/contents-store.ts` (add the bounded memo + a `fresh` head used by writes),
  `packages/domain/src/store.ts` (`VaultStore` head variant), `packages/domain/src/execute.ts` (write path calls the
  fresh head), `apps/worker/src/index.ts` (enable the TTL in production read composition); tests in
  `packages/github/src/read-budget.test.ts` and `apps/worker/src/wiring.test.ts`.
- Observable acceptance checks: with a counting fake `fetch`, (a) two concurrent tab reads on a warm isolate issue
  exactly one `/git/ref/heads/*` within the TTL; (b) after the TTL the next read issues a fresh ref call and returns
  the moved commit; (c) a write started inside the TTL still pins the true head (a concurrently moved head still
  yields `head-moved`, never a stale-base write); (d) a store for a different `(owner, repo)` never shares an entry.
- Risk floor: staleness ≤ TTL; writes unaffected (fresh head); per-isolate, O(1) memory; fail-open to the network on
  any error; no cross-repo/account reuse. Fallback if the write-path change is judged too invasive: ship the
  single-flight coalescing alone (one file, no TTL) — it captures the parallel-duplicate win with no staleness at all.

Do **not** start it in this packet.

## Test discovery integration needed

The shared `vitest.config.ts` `test.include` covers only `packages/*/src`, `apps/*/src`, `packages/*/test` and
`apps/*/test`, so the packet's command finds no file **by design of the shared config** (no code fault):

```
$ pnpm exec vitest run tools/sp-read-latency.test.ts --reporter=dot
No test files found, exiting with code 1
include: packages/*/src/**/*.test.ts, apps/*/src/**/*.test.ts, packages/*/test/**/*.test.ts, apps/*/test/**/*.test.ts
```

The one-line integration is to add `'tools/**/*.test.ts'` to that `include` array. It was **not** applied here
(shared config is out of scope for SP1). The benchmark itself was verified with a throwaway config
(`include: ['tools/**/*.test.ts']`, deleted after the run): **10/10 tests pass**.

## Reproduction

```powershell
# After integrating discovery, this is the packet command:
pnpm exec vitest run tools/sp-read-latency.test.ts --reporter=dot
# As run here (temporary local config, since deleted):
pnpm exec vitest run --config vitest.tools.tmp.config.mts --reporter=dot
pnpm -r exec tsc --noEmit   # 3 pre-existing TS6305 errors in packages/vault-markdown (test-vault/dist unbuilt); none in tools/
```
