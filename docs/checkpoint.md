# Checkpoint — 2026-10-02 (HC3a)

Overwrite this file at milestones only. ≤ 40 lines. Policy lives in `docs/orchestration.md`, not here.

## State

- **HC3a** (ADR-0043): `POST /api/health/ingest`, own service-token verifier (ingest AUD only, no email claim),
  rewrites only sent days of the health CSV via `executeWrite`. `HEALTH_INGEST_AUD` set by owner 2026-10-02.
- **UX1b** (bar, status dot → Status) · **B12** (ADR-0042) edit training; **B9** BTC history; **B11** Group training (ADR-0041); **B8**; **B7** — all live.
- FB1/FB2 (Report button, ADR-0040) live. Launcher gotcha: prepend Git's `bin` to PATH before
  `tools/launch-worker.ps1`, else `agent-pane.sh: No such file`.
- `pnpm -r exec tsc --noEmit` reads stale `dist` d.ts via project references; use `pnpm typecheck` (`tsc -b`).
- Workers cannot run Playwright; e2e failures surface only in the Lead's run — budget a Lead fix pass for UI slices.
- Parked: stray `sp-read-latency.test.ts` change in `git stash@{0}` (origin unknown).

## Next actions (in order)

1. **HC3a live 401** (owner set AUD + built Shortcut; Worker gets the Access JWT, still 401). Diagnostics deployed:
   the ingest route logs `errorCode: health-ingest:auth:<reason>` (no-token, bad-signature, iss, aud, expired,
   missing-claim, email-present, lifetime, other; never token/claims). Next Lead: run `wrangler tail` (filter route
   `/api/health/ingest`) in the background, post ACTION NEEDED "run the Shortcut once", read the code, fix the cause
   with a test (a Cloudflare-shaped service-token test already passes: type, aud[], sub:"", 24 h), deploy.
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
