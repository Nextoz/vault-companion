# ADR-0036 — Mood check-in writes daily-journal frontmatter values

**Status:** proposed by the Lead overnight (2026-10-01) under the owner's standing instruction; owner review pending.
Owner product decisions it implements: Ideas Backlog "Mood Check-in from the phone" (2026-09-29).

## Context

The owner wants a one-minute mood check-in on the phone, written where the desktop Mood Tracker plugin writes:
the frontmatter of `Journal/Daily/YYYY-MM-DD.md`. Until now the app never rewrote existing frontmatter
(`docs/vault-contract.md` §7). This is the first app write into `Journal/` and the first frontmatter edit.

## Decision

1. **Scope:** only the keys `mood`, `energy` (integers −3…3), `sleep` (hours 0…24, 0.5 steps) and `checkin_at`
   (ISO instant, one of the two forms already in the vault). Every other key, the body and line endings stay
   byte-identical; the app never clears desktop-only fields.
2. **Minimal splice:** each key must occur exactly once as a top-level line of the opening frontmatter. Only its value
   span is replaced. An existing value that is not empty or of the expected form (prose, lists, block scalars,
   comments) is a typed refusal — the app never overwrites prose.
3. **Missing note:** created from `Templates/Daily Journal Template.md`, filling only `{{date:YYYY-MM-DD}}`; any other
   placeholder is a refusal (later slice).
4. **Writes follow the usual guarantees:** operation ID, base revision, CAS on blob SHA, trailers, dedupe, and
   exact-inverse Undo (later slices; M1 is the pure splice only).
5. **Slices:** M1 pure splice + golden tests (this PR) · M2 Worker command + Undo + create-from-template · M3 Today
   card (Layout C) and collapsed "Checked in HH:MM".

## Consequences

- `vault-contract.md` gains a Journal section when M2 lands; §7's "never rewrites existing frontmatter" gets the
  exception for these four values.
- Notes whose fields hold prose are refused, not repaired; the owner fixes them on desktop.
- Undo: revert this PR (M1 has no runtime effect until M2 wires it).
