# RR1 integration review

## Scope
Bounded integration of the transplanted Research Radar candidate into the Scouts tab. No domain/contract changes, no live vault/network/credentials writes, no desktop Library producer.

## Changes
- `apps/worker/src/app.ts`: conflict resolved by preserving both Dashboard and Radar service methods, `isApiError` union members, and routes (`/api/dashboard`, `/api/dashboard/ticker`, `/api/radar/decisions`). Auth/CSRF/log policy untouched.
- `apps/web/src/ui/App.tsx`: passes `accountKey` and `blocked={writeBlocked || frozen}` to `Scouts`.
- `apps/web/src/ui/Scouts.tsx`: forwards those plus `refreshKey` to `ResearchRadar`, rendered only on the full Scouts page for a signed-in account.
- `apps/web/src/ui/Scouts.test.ts`: render helper updated for the two new required props; scouts-only tests remain signed-out (`accountKey: null`).
- `apps/web/src/ui/Scouts.radar.test.ts`: new focused mount assertion (mounted on full page; unmounted off-page and signed-out).
- `apps/web/e2e/mock-api.ts`: synthetic, contract-parsed Radar reads/read-note/decisions with append-and-dedupe semantics; Keep remains `pending`.
- `apps/web/e2e/research-radar.spec.ts`: new iPhone-width spec for collapse/expand, cards, note read, and safe Remove/Undo/Keep-pending.

## Verification
- `pnpm typecheck` passed.
- Touched tests passed (40): worker `research-radar.test.ts`, web `ResearchRadar.test.ts`, `Scouts.radar.test.ts`, `Scouts.test.ts`.
- Targeted `eslint` on all edited files passed.

## Notes for Lead
- `apps/worker/src/app.ts` is staged as resolved but not committed.
- Full `pnpm check` and full e2e remain Lead-owned.
- The Radar mock intentionally never returns `applied` for Keep, so the UI stays honest with "Saving to Library pending".
