# ADR-0037 — Dark iOS refresh uses CSS custom-property tokens, not Tailwind

**Status:** accepted by the Lead overnight (2026-10-02) under the owner's standing instruction; owner review pending.
Implements the Ready Backlog "UI - Dark iOS refresh" (owner decisions 2026-10-01), slice 1.

## Context

The backlog suggested Tailwind plus a few own components, and allowed the Lead to adjust with an ADR. The existing
`apps/web/src/styles.css` is already built on CSS custom properties (`--bg`, `--surface`, `--accent`, …) used by every
screen.

## Decision

1. **Tokens:** one permanent dark set of `--ios-*` variables (the owner's palette) in `:root`; the existing variable
   names map onto them, so every screen moves to the palette at once. Light theme, `prefers-color-scheme` and
   `[data-theme]` handling are removed.
2. **No Tailwind, no new dependency:** no build-step change, no CSP risk, no class churn in TSX. Screen styles stay in
   plain CSS scoped by `.app[data-tab=…]` (the only TSX change in slice 1 is `data-tab` on the app root).
3. **Today large title** is CSS generated content, so headings, accessible names and test selectors are unchanged.
4. **Weekly "tasks done" chart deferred:** Today loads no per-day completion history and the refresh adds no new
   requests; it moves to slice 4 (History), which already reads that data.
5. **Source chips** are coloured rounded squares without glyphs (generated content would leak into accessible names).

## Consequences

- Board-mode screens (Scouts, Dashboard, Weather, Radar) still carry their own hard-coded colours until slices 2–5.
- Undo: revert the slice PR.
