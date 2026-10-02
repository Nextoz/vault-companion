# Checkpoint — 2026-10-02 (HC3a)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **HC3a** (ADR-0043; Pro worker, both reviewers: 2 real fixes incl. a wiring bug that made the route always 404,
  now covered by `health-ingest-wiring.test.ts`; pnpm check 1885 + e2e 103/104, `actions.spec` flaky under load, 2/2
  alone): `POST /api/health/ingest`, own service-token verifier (ingest AUD only, no email claim), rewrites only
  sent days of the health CSV via `executeWrite`. Off (404) until secret `HEALTH_INGEST_AUD` is set.
- **UX1b** live: bar Today · Tasks · Scouts · Notes · Log; status dot → Status (Back + Actions).
- **B12** (ADR-0042) edit training; **B9** BTC history; **B11** Group training (ADR-0041); **B8**; **B7** — all live.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Workers cannot run Playwright; e2e failures surface only in the Lead's run — budget a Lead fix pass for UI slices.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **HC3a** deployed (afc5b960) but **off**: owner sets `HEALTH_INGEST_AUD`, builds the Shortcut per
   `docs/health-shortcut.md`, runs it once → fix the parser for any field/line error the owner reports (names only).
2. **HC3b** history view: range chips 30 d / 90 d / 1 y / all for steps, headphone, first/last move (Flash, ordinary).
3. Then UX2–UX5 (UX1b overrides them where they differ) → AB AI budget card → NY Needs You + Morning Review → SP
   phone measurement (re-read the backlog).

## Owner items

- Phone: bottom bar Today · Tasks · Scouts · Notes · Log; Tasks → Today/All; Log → Training/Progress; status dot →
  Status → Back (UX1b). Tell me if the cockpit order on Today feels right.
- Phone: Log → Training → tap a session → change a value → Save changes; status dot → Actions → Undo (B12).
- Phone: Log training → Workout → Group training → class → Save; suggestion next time (B11). BTC 1W/1M/3M (B9).
- Phone: Today → mood check-in on a day with no journal note yet → saves (B7); rows labelled (B8).
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.


## Budget

DeepSeek $7.88. GLM ~249k/900k.
