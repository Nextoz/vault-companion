# SP2 independent repair — evidence

Head: `a64f8ca03ac92cc797665f33421f972be9f01f08`. Independent review:
`C:/Dev/vault-companion-clones/review-sp2/docs/reviews/SP2-independent-pro.md`. All fixtures are synthetic; no private
vault text, network, or live vault access.

## Validation

- Combined affected run: 6 files / 88 tests passed (no skips).
- `pnpm typecheck` (`tsc -b`): clean, exit 0.
- Targeted `pnpm exec eslint` on the touched files: clean, exit 0.
- No full `pnpm check`/e2e run (Lead owns those).

## Finding dispositions

1. Malformed `type` treated as absence — FIXED in `packages/github/src/contents-store.ts:175-177`.
   Missing/non-string/unknown `type` now throws `StoreUnavailable`; only 404 or explicit
   `dir`/`symlink`/`submodule` resolves `null`. Added `read-cache.test.ts` cases for non-string and unknown `type`
   with a later valid retry, plus a directory-absence test proving it is never cached.
2. Synthetic `size` as char length — FIXED in `read-budget.test.ts:23`, `write-budget.test.ts:67`, and
   `undo-budget.test.ts:77`. Fixtures now report `new TextEncoder().encode(text).byteLength`. No production
   SHA/size/base64 checks, CAS, dedupe, or receipt assertions were relaxed.
3. SP1 stale benchmark — FIXED in `apps/worker/test/sp-read-latency.test.ts`.
   Repeat immutable blob reads now assert exact `blob: 0` and `head: 1` per action; the cached-repeat wall-time
   assertions were replaced with exact request-count equality. A new test proves three fresh head fetches and a
   different note path refetches its blob. Undo budget counts already reflected the real cache shape (13/13), while
   stale/conflict/unknown-outcome coverage remains intact.
4. Pending-map overflow unobserved — ADDED in `read-cache.test.ts`.
   New test holds 32 distinct unresolved reads, then one extra path issued twice falls back to two independent
   requests: 34 Contents GETs total, all valid, then all settle. The existing 160-concurrent oracle is unchanged.
   The misleading "key evicted by 128 insertions" test name/report claim is corrected to "128 insertions fill the
   cache before settlement"; the flight retains its bytes independently of cache residency.
5. Store lifetime — CORRECTED in `docs/reviews/SP2-read-cache.md:54-56`.
   `apps/worker/src/index.ts:57,138` caches the app/store per env at module scope, so the bounded cache spans
   requests within one isolate; it is never global or shared across auth identities/envs. No phone-speed claim.

## Actual per-file counts

- `read-cache.test.ts`: 28 passed.
- `contents-store.test.ts`: 23 passed.
- `read-budget.test.ts`: 5 passed.
- `undo-budget.test.ts`: 13 passed.
- `write-budget.test.ts`: 8 passed.
- `sp-read-latency.test.ts`: 11 passed.
