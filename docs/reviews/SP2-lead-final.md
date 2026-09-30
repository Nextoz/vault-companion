# SP2 Lead final verification — 2026-09-30

Bound: candidate85070b6 plus read-cache/read-budget test corrections and report clarifications; production files unchanged.

- Independent mutation: replaced pending join return with cache re-read. The new concurrent-eviction oracle FAILED at read-cache.test.ts311 (f2 null). Exact original production bytes restored in finally; production diff empty.
- Independent full pnpm check: lint/typecheck PASS;104 files/1478 tests PASS, 17:37:59 start,147.99s. No retry-to-green.
- Browser: historical80/80 run recorded at production85070b6, saved last-run passed/failedTests[]. No current browser rerun claimed. Current delta only tests/reports, no web/worker runtime changes.
- CodeRabbit4145912475: deterministic gated concurrent fillers now evict target, joiner retains result, subsequent target read refetches; mutation proves guard sensitivity.
- CodeRabbit4145912461: old88/latency11 evidence explicitly labelled historical in both original reports; current affected90/latency13 recorded separately, not a rewritten old result.
- UTF8fixture uses byteLength; validation/size/CAS/dedupe untouched. No private data or .agent content committed.
- Fresh independent Pro final review, final-head Ubuntu/Windows CI and actual CodeRabbit final disposition pending. PR remains draft/hold; no acceptance/merge/deploy claimed.
