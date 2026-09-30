# SP2 read cache — per-instance immutable revision read cache

Date: 2026-09-30. Scope: `packages/github/src/contents-store.ts` read path only, plus new tests and this report.
No domain/API/auth/write/head/tree changes, no TTL, no configs/harness/CI, no live vault/network/secrets, no deploy.

## Result

`pnpm exec vitest run packages/github/src/read-cache.test.ts packages/github/src/contents-store.test.ts packages/github/src/read-budget.test.ts packages/github/src/undo-budget.test.ts packages/github/src/write-budget.test.ts apps/worker/test/sp-read-latency.test.ts --reporter=dot`
passes 6 files / 88 tests after the SP2 independent repair. `pnpm typecheck` (tsc -b) and targeted `pnpm exec eslint`
on the touched files pass. No full `pnpm check`/e2e was run (Lead owns that).

## Implementation

- `GitHubContentsStore` now has three private fields: `readCache` (`Map<key, CachedFile>`), `readCacheBytes`, and
  `pendingReads` (`Map<key, Promise<StoredFile | null>>`). All are per store instance; no module/global shared bytes.
- Cache key is exactly `${commitSha}\0${path}`. Lookup/single-flight happen only for `/^[0-9a-f]{40}$/` commits;
  non-SHA refs are fetched afresh and never cached. `guardPath(path)` runs before any lookup.
- A single-flight retains its fetched result and returns a separate byte copy to every joining caller, so eviction of
  that key by later insertions cannot turn a successful fetch into `null`. `null` is only true absence: a 404, or an
  explicit supported non-file type (`dir`/`symlink`/`submodule`).
- A missing, non-string, or unknown `type` fails typed (`StoreUnavailable`) instead of being treated as absence. Only
  settled `type === 'file'` answers with a valid 40-hex `sha`, safe non-negative integer `size` within 1 MiB,
  `encoding: 'base64'`, valid base64 whose decoded length is within 1 MiB and equals the declared `size` are cached.
  Malformed metadata/encoding/base64 and inconsistent sizes fail typed (`StoreUnavailable`) and stay uncached; any
  over-limit path fails `FileTooLarge`. Encoded length is bounded before decoding. `head()` is untouched and still
  fetches the ref every call.
- Bytes are copied into the cache (`Uint8Array.slice()`) and every caller receives another `slice()`, so mutating any
  returned array cannot affect the cache or other/later/concurrent callers. `blobSha`/`commitSha` are preserved.
- Bounds: <=128 entries and <=8 MiB resident decoded bytes; insertion evicts oldest-first while over either limit, and
  an entry larger than the byte budget bypasses storage. Single-flight is capped at <=32 pending distinct keys; a
  further key falls back to an uncached fetch. Pending entries are removed via `.finally()` after settle/reject.

## Measured request counts (synthetic fake fetch)

- Sequential identical `(path, commit)` reads: 3 reads → 1 Contents GET.
- Concurrent identical reads with single-flight: 2 reads → 1 Contents GET; a later cache hit adds 0.
- Other path or commit: independent Contents GET each.
- `head()` twice: 2 ref GETs regardless of cache; moved head returned changed bytes while the prior commit remained
  exact on re-read.
- 404 → 503 → oversized → valid → cache hit: 4 Contents GETs for the four non-cached attempts, then 0 for the hit.
- Failed concurrent single-flight then retry: 2 Contents GETs (one shared failure, one retry).
- 129 distinct entries then re-read the first: 130 Contents GETs (entry-count eviction). 8 × 1 MiB entries plus one
  1-byte entry then re-read the first big entry: 10 Contents GETs (byte-budget eviction).
- 160 concurrent distinct valid reads: 160 Contents GETs, 0 nulls. Gated single-flight joiners still return their
  fetched bytes after 128 insertions fill the cache before settlement (the flight retains the result independently of
  cache residency). 404/absence twice: 2 GETs. Each malformed response + recovery: 2 GETs.
- Pending-map overflow: 32 unresolved distinct reads held, then two independent fallback requests for one extra path:
  34 Contents GETs total, all valid, then all settle.

No production/phone latency is claimed; these are request counts from a deterministic fake `fetch`.

## Safety and limits

- Memory lifetime is the store instance. Production composition caches the app, and therefore one store, per env at
  module scope (`apps/worker/src/index.ts:57,138`), so the bounded cache spans requests within one isolate; it is never
  global and is never shared across auth identities/envs. Nothing is persisted to disk and private bytes are never logged.
- Unsafe paths still throw before any cache lookup or fetch. Private-byte isolation is enforced per store instance and
  per caller copy.

## Handoff notes

This cache touches private-data isolation and concurrency: hold the PR until the Lead performs the full diff review and
verification, followed by an independent Claude floor review. No production deploy. Do not expand this into TTL,
parser/UI, or RR work.
