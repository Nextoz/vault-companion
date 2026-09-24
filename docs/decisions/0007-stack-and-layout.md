# ADR-0007 Stack and repository layout

Status: Accepted (hub's preferred stack, trimmed to need)

TypeScript (strict) + pnpm workspaces; Vitest; Zod; Hono (Workers + Node adapter); React + Vite PWA;
Playwright (WebKit). Deferred until a feature needs them: TanStack Router/Query (a 3-screen app uses
plain state + fetch), D1, Wrangler deployment config (added at the deploy gate).

Layout per `docs/architecture.md`. The same Hono app runs on Node for the disposable end-to-end harness
with `LocalGitStore`; production uses `GitHubContentsStore` on Workers.

Toolchain note (2026-09-24): TypeScript pinned to `~6.0` because typescript-eslint 8.70 supports `<6.1`;
move to TS 7 when typescript-eslint does.
