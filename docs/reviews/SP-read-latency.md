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

`apps/worker/test/sp-read-latency.test.ts` asserts the harness (see below). Cold = the first request on a brand-new
app/store (token, head and tree caches all empty). Repeat = the next requests on that same app.

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
4. **A cold note open costs one more request than a cold list.** A note read is the colder list's `head` + `tree`
   plus the note's `blob` (table: note-read 104.5 ms vs notes-list 76.9 ms cold), so of those two it is the heavier
   path. It is **not** the heaviest read in the table: cold `scouts` (145.5 ms, three tree probes) and cold
   `history` (114.4 ms, two blobs) measure higher with their own request mixes.
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

## Cache candidates — recommendation status

Nothing here is implemented in this packet; these stay recommendations.

- **Immutable-by-revision contents are the low-risk candidates.** Directory listings per `(commit, dir, recursive)`
  are already cached in-isolate, and caching blobs per `(repo, blobSha)` would never serve a moved revision. Either
  could be scoped into a later SP2 contract.
- **`head` (the mutable branch tip) — Lead decision for now: no TTL head cache.** A TTL trades freshness for calls,
  and routing the write path around a cached head would widen the write surface; both merit a separate floor review
  before any contract. **Single-flight coalescing alone** (no TTL, so no staleness window) is the other candidate
  for that later SP2 contract.

Risk floor to respect in any follow-up: keys include owner/repo/installation (never one shared entry for private
bytes), bounded memory with fail-open behaviour, and a `head` that is never the base of a write.

Do **not** start any of it in this packet.

## Discovery and reproduction

The benchmark test was moved from `tools/sp-read-latency.test.ts` (outside the shared Vitest `include`, so the old
command never found it) to `apps/worker/test/sp-read-latency.test.ts`, which the shared `include` already covers.
Only its relative imports changed (re-pointed at the repository root); the harness `tools/sp-read-latency.mjs` is
unchanged, with no duplicate copy and no `vitest.config.ts` edit.

```powershell
pnpm exec vitest run apps/worker/test/sp-read-latency.test.ts --reporter=dot   # 10/10 pass
pnpm typecheck                                                                 # tsc -b, clean
```
