# SP2 final review fix — evidence

Head: `85070b6`. Scope: test oracle correction in `packages/github/src/read-cache.test.ts` only; no production,
domain, write, dependency, credential, or report-history edits. The dirty `read-budget.test.ts` fixture fix is preserved.

## Actual current run (head `85070b6`)

`pnpm exec vitest run packages/github/src/read-cache.test.ts packages/github/src/contents-store.test.ts
packages/github/src/read-budget.test.ts packages/github/src/undo-budget.test.ts packages/github/src/write-budget.test.ts
apps/worker/test/sp-read-latency.test.ts --reporter=dot` → 6 files / 90 tests passed (no skips).

- `read-cache.test.ts`: 28 · `contents-store.test.ts`: 23 · `read-budget.test.ts`: 5 · `undo-budget.test.ts`: 13 ·
  `write-budget.test.ts`: 8 · `sp-read-latency.test.ts`: 13.
- `pnpm typecheck` (`tsc -b`): clean, exit 0. Targeted `pnpm exec eslint` on both touched test files: clean, exit 0.
- No full `pnpm check`/e2e was run (Lead owns those).

## Finding dispositions

1. CodeRabbit 4145912475 — FIXED in `read-cache.test.ts`. The serial 128-filler test finished every filler before
   resolving the target gate, so the settled entry was never evicted and a cache-reading joiner would still pass.
   Replaced with a deterministic concurrent oracle: the target flight is gated, two callers join it, and 128 gated
   fillers are issued before the target gate is resolved first and all filler gates second. Queue order forces all 128
   filler `storeRead`s ahead of the joiner's resume, evicting the just-settled target entry; the joiners must still
   return the retained flight bytes, and a later read of the same key must refetch (`targetGets` 1 → 2).
2. Mutation proof: changed the join branch to `await pending; const cached = readCache.get(key); return cached ? … :
   null` (reads cache instead of retaining flight result). The new oracle failed with `expected null not to be null`
   on the joiner. Production was reverted to the exact prior bytes (`git diff -- contents-store.ts` is empty).
3. CodeRabbit 4145912461 — NOT falsified. `SP2-read-cache.md` and `SP2-repair-evidence.md` remain as the historical
   88-test/latency-11 run. This file records the accurate current run above: 90 tests, latency 13, head `85070b6`.
4. `read-budget.test.ts` fixture: `TODO.length` → `new TextEncoder().encode(TODO).byteLength`. Intended synthetic-only
   correction; production UTF8/size/CAS guards untouched. Its 5 tests execute and pass (a wrong declared size would
   fail `fetchRead`'s `bytes.byteLength === size` guard).

## Remaining gates

- Lead full `pnpm check` + e2e before merge; independent Claude floor review still required.
- No production deploy; preserve all other pending32/160/distinct-key/byte-copy holdouts (unchanged, still passing).
