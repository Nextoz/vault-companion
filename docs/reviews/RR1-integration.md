# RR1 integration review

## Status
Prior snapshot of the Research Radar integration as reviewed; current source is authoritative, not this file.

## Scope
Bounded integration of the transplanted Research Radar candidate into the Scouts tab. No domain/contract changes, no live vault/network/credentials writes, no desktop Library producer.

## Current source
- `GET /api/radar` — Research Radar read model.
- `GET /api/radar/read` — server-side Radar note read by paper ID header.
- `POST /api/radar/decisions` — append-only Radar decision write.

## Changes (snapshot)
- `apps/worker/src/app.ts`: conflict resolved by preserving both Dashboard and Radar service methods, `isApiError` union members, and routes (`/api/dashboard`, `/api/dashboard/ticker`, `/api/radar`, `/api/radar/read`, `/api/radar/decisions`). Auth/CSRF/log policy untouched.
- `apps/web/src/ui/App.tsx`: passes `accountKey` and `blocked={writeBlocked || frozen}` to `Scouts`.
- `apps/web/src/ui/Scouts.tsx`: forwards those plus `refreshKey` to `ResearchRadar`, rendered only on the full Scouts page for a signed-in account.
- `apps/web/src/ui/Scouts.test.ts`: render helper updated for the two new required props; scouts-only tests remain signed-out (`accountKey: null`).
- `apps/web/src/ui/Scouts.radar.test.ts`: new focused mount assertion (mounted on full page; unmounted off-page and signed-out).
- `apps/web/e2e/mock-api.ts`: synthetic, contract-parsed Radar reads/read-note/decisions with append-and-dedupe semantics; Keep remains `pending`.
- `apps/web/e2e/research-radar.spec.ts`: new iPhone-width spec for collapse/expand, cards, note read, and safe Remove/Undo/Keep-pending.

## Verification (snapshot)
- `pnpm typecheck` passed.
- Touched tests passed (40): worker `research-radar.test.ts`, web `ResearchRadar.test.ts`, `Scouts.radar.test.ts`, `Scouts.test.ts`.
- Targeted `eslint` on all edited files passed.

## Notes
- The Radar mock intentionally never returns `applied` for Keep, so the UI stays honest with "Saving to Library pending".

## Lead independent high-risk review (2026-10-01, Claude Opus 5.5)
Scope: write path only — `research-radar-command.ts`, `research-radar-format.ts`, history reader, `paths.ts`
`canWrite`/`parseVaultPath`, `POST /api/radar/decisions`, wire schemas — against AGENTS.md 3–4 and ADR-0032.
- Pass: operation ID = `decisionId`; reads and listing pinned to one commit X; head-CAS via `baseCommit: X`;
  op/payload trailers; trailer dedupe plus an in-log decision-ID check; `deriveApplied` verifies the exact append.
  Server-month target; prior months never touched. Only the Radar plan reaches the JSONL path (other `canWrite`
  callers build Inbox/Explained paths). Command and line schemas share `RadarCard`/`isoInstant`/`uuid`, so an
  accepted write cannot make its own log unreadable. Route has the same Origin/X-VC-Request/JSON/account/body guards.
- Fixed: the in-log decision-ID guard had no test of its own (removing it only changed the code to `invalid`).
  Added a negative test that fails when the guard is disabled (verified).
- Recorded, not blocking (fails closed): once any log is older than the 25-month window, every Radar read and write
  is refused until old logs are archived. Needs a rollover/archive design before about 25 months of use.
