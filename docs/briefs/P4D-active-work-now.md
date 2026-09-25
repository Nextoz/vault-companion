# Brief P4-D — Active Work Now card (ADR-0012 "chosen work")

Type: implementation (bounded). Branch `agent/active-work-now` from `agent/linked-notes` (reuses its renderer and
store/listing code; the Lead updates it from `main` after PR #8 merges).

## Objective

Show `Tasks/Active Work Now.md` read-only at the top of Today, as the owner's chosen outcomes. No task mapping is
inferred and nothing is completed from the card (ADR-0012, `docs/product-contract.md` "Today").

- Server: `GET /api/active-work` — fixed path `Tasks/Active Work Now.md` (already an allowed read-only context in
  `docs/vault-contract.md` §1), read at one pinned head, same auth/`no-store`/logging rules as `/api/linked-note`
  (no text or path in logs), 1 MB guard, missing file ⇒ `{ status: 'absent' }` (not an error). Contract in
  `packages/contracts`, service in `packages/domain`, wired in **both** `apps/worker/src/app.ts` and
  `apps/worker/src/index.ts` (production composition test like `wiring.test.ts`).
- Web: a collapsible "Active work" card above Today (expanded by default, remembers collapse per device via prefs),
  rendered with the existing sanitised renderer (`apps/web/src/note/render.ts`); wikilinks inside it render as plain
  text (no navigation in this increment). Loading/error/absent states are quiet and never block the task lists.
  Nothing from the card is stored in IndexedDB or the SW cache.

## Owned files

`packages/contracts/src/**`, `packages/domain/src/active-work.ts` (+ test), `apps/worker/src/{app,index}.ts` (route +
wiring only) and tests, `apps/web/src/{api.ts,reads.ts,prefs.ts}`, `apps/web/src/ui/{App.tsx,ActiveWorkCard.tsx}`,
web e2e spec, handoff.

## Acceptance

Unit: absent file, too large, upstream unavailable, text never logged, production wiring (400/200 not 404). Web: card
renders sanitised content (reuse XSS corpus on one case), collapse remembered, lists still render when the card
errors. e2e: card shown above Today via the mock API. `pnpm check` + web e2e green; break each guard once.

## Handoff

`.agent/handoffs/P4D-active-work-now.md` (Completed / Important discoveries / Recommend / Verification / Commit).
Push early; final line `P4D DONE <sha>`.
