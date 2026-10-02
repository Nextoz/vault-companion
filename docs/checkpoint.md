# Checkpoint — 2026-10-02 (HC3b history view)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **HC3b**: Health card → **History** toggle (lazy `GET /api/health/history`, all rows ≤ yesterday; chips 30 d / 90 d / 1 y / All slice client-side; range medians + SVG lines). Shares `readSource` with the card.
- **HC3a** (ADR-0043): `POST /api/health/ingest`, own service-token verifier (ingest AUD only, no email claim),
  rewrites only sent days of the health CSV via `executeWrite`. **Live and working with the real Shortcut.**
  Root causes: Access session lifetime > 24 h (401), a trailing space in the Shortcut's `steps` key (422). Ingest
  now trims key names (null-prototype map, 400 on collision); 400/422 answers append the body shape (no values).
- **UX1b** (bar, status dot → Status) · **B12** (ADR-0042) edit training; **B9** BTC history; **B11** Group training (ADR-0041); **B8**; **B7** — all live.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Workers cannot run Playwright; e2e failures surface only in the Lead's run — budget a Lead fix pass for UI slices.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **MB0 + MB1** (owner 2026-10-02, before UX2). MB0: ADR-0044 merged; waiting on owner Google setup
   (vault note "Morning Brief - Owner Setup Steps") + `tools/google-token-spike.ps1` day-0 PASS, then build the
   Worker Google reader (Pro, `-Reviewer both`); day-8 re-run ≥ 2026-10-10 gates MB "done". MB1a merged (pure day
   model `packages/domain/src/morning-brief.ts`: `freeBlocks` 07–22 local DST-safe, `rankTodos` bills/due ≤ 3 d →
   overdue → rest, max 3; `stateLine` above/below flags, low = mood or energy ≤ −2). **Next: MB1b** gatherers +
   Scaleway writer, then MB1c brief JSON write target (ADR) + 06:30 cron + email.
   Tooling note: pass `handoff-check.ps1 -Clone` as an absolute path (a relative one writes the report to a nested dir).
2. UX2–UX5 (UX1b overrides them where they differ) → **MB2** right after UX2 → AB AI budget card → NY Needs You +
   Morning Review → SP phone measurement (re-read the backlog).

## Owner items

- Phone: Today → Health → History → tap 30 d / 90 d / 1 y / All; values and lines look right (HC3b).
- Phone: bottom bar Today · Tasks · Scouts · Notes · Log; Tasks → Today/All; Log → Training/Progress; status dot →
  Status → Back (UX1b). Tell me if the cockpit order on Today feels right.
- Phone: Log → Training → tap a session → change a value → Save changes; status dot → Actions → Undo (B12).
- Phone: Log training → Workout → Group training → class → Save; suggestion next time (B11). BTC 1W/1M/3M (B9).
- Phone: Today → mood check-in on a day with no journal note yet → saves (B7); rows labelled (B8).
- Review ADR-0036 (Mood), 0037 (UI tokens), 0038 (last copy), 0039 (health), 0040 (report button); decide on `git stash@{0}`.


## Budget

DeepSeek $7.76. GLM ~270k/900k.
