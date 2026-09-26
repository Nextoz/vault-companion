# Brief O3 — real PWA queue against the real server stack (Claude Cloud)

Read `AGENTS.md` (incl. "Worker token economy"). Branch `agent/o3-real-queue`. Push early (a stub handoff within
the first minutes), push again at the end. Do not open a PR, do not spawn agents, do not edit `docs/plan.md`.

## Finding (review O3, verbatim)
"The real PWA queue never runs against the real server stack. The disposable e2e uses a plain-HTTP `Phone` with a
five-try loop; every Playwright scenario runs against a mocked API. Receipts → `known` → acknowledgement → watermark →
eviction, the Undo draft token fill, and `writeBlock` banners are each tested on only one side of the wire."

## Task
One new Playwright project (config in `apps/web/playwright.config.ts` or a sibling config) that serves the **built**
web app and the `packages/e2e` harness server on **one origin** (harness uses `LocalGitStore` on a temp bare repo;
use the harness's existing test auth — no real Access, no secrets), with three flows:
1. offline burst of ≥ 25 actions (captures + completions) → go online → all acknowledged; the vault file has each
   change exactly once; saved-actions list drains.
2. complete + Undo tapped before the completion's receipt arrives (draft token) → one completion commit + one undo
   commit; task open again.
3. desktop writes conflict markers into `Tasks/To-Do List.md` → write-block banner → markers resolved on the
   "desktop" side → writes resume.
Each flow must fail if its guard is broken: state in the handoff which mutation you tried per flow and that it failed.

Synthetic data only (`packages/test-vault` style). Keep the harness changes minimal; reuse existing helpers.
Run only the new project + `pnpm -r exec tsc --noEmit`; CI runs the rest.

## Handoff
`.agent/handoffs/O3-real-queue-e2e.md` ≤ 20 lines: Completed / Discoveries / Recommend / Verification (commands +
results) / Commit SHA.
