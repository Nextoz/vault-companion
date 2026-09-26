# Brief: Phase 2 gate — whole-system midpoint review (fresh context, adversarial)

Type: **review** (read-only). Assume the system is wrong somewhere and find where. You did not write it.
Two independent reviewers receive this brief (Claude Opus 5.5 on Claude Code Cloud, GPT-6 Astra via Codex); do not
look for or read the other's report.

## Scope

The **whole system** on `main` after **all milestone-1 streams** merged — Phase 2 harness (`packages/e2e`), offline
service-worker tests, deploy scaffold and `_headers`, linked notes, client correctness, draft recovery, Today rule, judged end to end rather than
per file: phone PWA → queue → HTTP → auth → command services → executor → store → Git → desktop clone → sync model.

- Evidence under review: `packages/e2e/**` and `docs/briefs/P2A-report.md` — does the disposable end-to-end
  actually prove the `docs/testing.md` "Disposable end-to-end" list and `docs/sync.md` W1–W5 / proof table?
- Phase 1 fixes still hold under the real loop: `docs/reviews/phase-1-reconciliation.md` (spot-check the Critical
  and High items against e2e behaviour, not just unit tests).
- Readiness for Phase 3 (live canary prep): what would go wrong the first time this meets real GitHub, the real
  Windows sync worker and a real iPhone? `docs/testing.md` "Canary evidence", `docs/security.md`, `docs/threat-model.md`.

Normative specs: `docs/product-contract.md`, `docs/vault-contract.md`, `docs/commands.md`, `docs/sync.md`,
`docs/security.md`, ADRs in `docs/decisions/`.

## Must not

Edit any file except your report. No git commands that change state. Never open
`C:\Dev\vault-companion-vault-reference` or any live vault. No network writes. Do not spawn agents. You may run
`pnpm test`, `pnpm typecheck`, `pnpm lint`, and throwaway scripts **only under your OS temp dir**.

## Hunt for

0. **Overlaps between streams**: IndexedDB schema/migrations (queue + drafts), service-worker caching vs. note view
   and drafts, task identity vs. Undo-in-Done-today vs. conflict UI, `_headers` CSP vs. the note renderer.

1. **Acceptance-story failures** (`docs/product-contract.md`): any path where, with the computer off, a dropped
   connection loses or duplicates the action, or a conflict is hidden or loses a version. Construct the interleaving
   and, where possible, run it through the e2e harness in a temp copy.
2. **Harness gaps**: scenarios that pass without proving their claim; required scenarios missing; places where the
   harness differs from production composition (`apps/worker/src/index.ts`) in a way that hides a bug.
3. **Cross-layer seams**: receipt/`known=` watermark vs. read model after desktop merges; conflict markers committed
   by the desktop and every command's behaviour afterwards; capture anchor vs. QuickAdd; Undo after desktop edits.
4. **Phase 3 blockers**: anything that must change before the first live write (G3), ranked.
5. **Delayed offline captures**: a capture or completion queued offline for hours or days, sent after many desktop
   commits — dedupe window, stale `baseRevision`, capture anchor, Today/Done dates across midnight, draft vs. queue.
6. **Request budget per write command** (CompleteTask, UndoCompleteTask, CaptureTask, CaptureNote): count GitHub calls
   per attempt and worst case over retries, including token acquisition and paged dedupe for non-Undo commands with an
   old `baseRevision`; compare with Workers Free (50/invocation) and GitHub's ~5,000/h installation limit.
7. **Phone experience end to end**: Today usefulness (Active Work Now + rule), capture speed, draft recovery,
   understandable save/conflict states, safe Undo, readable linked context — list what is verified vs. untested.
5. **Vacuous tests** among the e2e scenarios (name the line whose breakage should fail each).

## Output

Report file named in your launch prompt (`docs/reviews/phase-2-review-{opus,astra}.md`): findings table
`id | severity Critical/High/Medium/Low | file:line | problem | concrete failing input or interleaving | recommended fix`
(Critical = reachable durable loss/duplication/wrong-task write or auth bypass), then "Evidence run", then
"Phase 3 blockers", then "What is sound", then verdict `PASS` / `PASS WITH FIXES` / `BLOCK`.
Final terminal line only: `VERDICT: <verdict> — <n> findings (<c> critical, <h> high) — <report path>`.
Cloud reviewer: commit only your report on branch `agent/phase-2-review-opus` and push it.
