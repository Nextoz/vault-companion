# SP2 read cache — per-instance immutable revision read cache

Date: 2026-09-30. Scope: `packages/github/src/contents-store.ts` read path only, plus new tests and this report.
No domain/API/auth/write/head/tree changes, no TTL, no configs/harness/CI, no live vault/network/secrets, no deploy.

## Result

`pnpm exec vitest run packages/github/src/read-cache.test.ts packages/github/src/contents-store.test.ts packages/github/src/read-budget.test.ts --reporter=dot`
passes 3 files / 38 tests. `pnpm typecheck` and targeted `pnpm exec eslint` on the two touched files pass. No full
`pnpm check`/e2e was run (Lead owns that).

## Implementation

- `GitHubContentsStore` now has three private fields: `readCache` (`Map<key, CachedFile>`), `readCacheBytes`, and
  `pendingReads` (`Map<key, Promise<void>>`). All are per store instance; no module/global shared bytes.
- Cache key is exactly `${commitSha}\0${path}`. Lookup/single-flight happen only for `/^[0-9a-f]{40}$/` commits;
  non-SHA refs are fetched afresh and never cached. `guardPath(path)` runs before any lookup.
- Only settled `type === 'file'`, base64, under `MAX_CONTENT_BYTES` answers are cached. `null`/404, directories,
  errors, malformed shapes, and oversized answers are never cached. `head()` is untouched and still fetches the ref
  every call.
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
  small entry then re-read the first big entry: 10 Contents GETs (byte-budget eviction).

No production/phone latency is claimed; these are request counts from a deterministic fake `fetch`.

## Safety and limits

- Memory lifetime is one isolate: the cache and pending map live for the store instance and are reclaimed with it.
  Nothing is persisted to disk and private bytes are never logged.
- Unsafe paths still throw before any cache lookup or fetch. Private-byte isolation is enforced per store instance and
  per caller copy.

## Handoff notes

This cache touches private-data isolation and concurrency: hold the PR until the Lead performs the full diff review and
verification, followed by an independent Claude floor review. No production deploy. Do not expand this into TTL,
parser/UI, or RR work.
