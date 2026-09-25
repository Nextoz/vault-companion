# K2 report — kernel fixes from the Phase 1 gate

Branch `agent/kernel-fixes`. Scope: `packages/vault-markdown/**`, `packages/test-vault/**` only. Every reviewer
reproduction was written as a test first and seen failing for the stated reason before the fix.

## Fixes

| Finding | Fix (`packages/vault-markdown/src`) |
|---|---|
| R1/A1 exact Undo wrong section | `exactInverse` takes the blank count from the effect (`blankInserted`) instead of guessing, accepts a candidate only if re-completion reproduces the bytes **and the whole effect** (`sameEffect`, every `CompleteEffect` field — `EFFECT_FIELDS` is `Record<keyof CompleteEffect, true>`, so a new field fails to compile until compared), and only if the candidate original is unique; otherwise falls through to the semantic inverse. `exactUndo(text, effect)` is exported from `mutations.ts` (not `index.ts`) so the exact path is testable on its own. |
| R2/A5 semantic Undo adopts lines | No-adoption rule on every route (anchor and fallback): if the next non-blank line at the insertion point is indented ⇒ `refused:structure`. `verifiedUndo` asserts the restored block has exactly the completed block's size and every other indexed task keeps its line and block length (in order). |
| R6 throws on reachable inputs | Complete: `refused:structure` when the Done insertion point is not clean (Done ends inside an unclosed fence/comment). Undo: anchors count only on visible lines. |
| R7 blank residue | `CompleteEffect.blankInserted: boolean` (`api.ts`). The semantic inverse removes the blank above the block when `blankInserted`, the line is still blank and Done has no other non-blank content (§4.2). |
| R13 NBSP after block ID dropped | Only `[ \t]` is trimmed. Trailing non-ASCII whitespace after a block ID stays attached to the ID (`… ✅ date ^abc<NBSP>`), so the ID is still trailing as the parser (`trimEnd`) and Obsidian read it. Appending ✅ after the NBSP would have silently broken the block reference. |
| R14 capture before prose | `captureInsertionPoint` refuses when the first non-blank Open line is not a list item. The semantic Undo fallback uses the same point (§4.2 → §4.4), so it refuses too. |

## Tests added (345 total, was 313; +32)

- `review-fixes.test.ts` (27): each R/A reproduction verbatim, plus Done above Open in LF/CRLF × {no final
  newline, BOM, BOM + no final newline}, the effect-mismatch case (flipped `blankInserted` ⇒ exact declines),
  "anchor gained children", "indented line after heading anchor", Astra A5, R7 both section orders plus the
  "still blank" and "Done has other content" guards, R6 fence/`%%`/hidden anchor, R13 ×3, R14 ×4.
- Golden `complete-done-above-open` (fixtures `todo-done-above-open.md` + expected, LF authored, CRLF generated) in
  the existing golden loop: complete bytes + A3 exact Undo, LF and CRLF. The golden loop now also asserts
  `effect.blankInserted` for every case.
- `undo.property.test.ts`: seeded generator (mulberry32, seed `0x5eed2609`), **4,000 documents** (Done above/below
  Open, LF/CRLF, BOM, final newline or not, children, twins, fences, `%%`, prose, indented strays, subheadings,
  open items and unclosed fences/comments in Done). Properties: P1 `exactUndo(complete(d)) === d` or declines;
  P2 complete/undo/capture never throw; P3 a successful semantic Undo preserves every task and block length of d.
  Run: 4,556 completions (2,257 Done-above-Open), exact accepted 4,556 / declined 0, semantic ok 4,119 /
  refused 437, complete refused 173; ~2.6 s. Coverage floors are asserted so the generator cannot silently degrade.
- One existing expectation changed: `fallback into an empty Open` pinned the R7 residue (a trailing `\n` after
  `## Done` in a file without final newline). It now expects the residue removed; still an exact byte assertion.

## Mutation results (each guard broken, tests run, file restored)

| Mutant | Result |
|---|---|
| M1 exact: compare `insertedAt` only (old check) | killed (effect-mismatch test) |
| M2 exact: accept first of several originals | **survives — equivalent**: the two EOF readings always join to the same original string, so the set never has two members. Kept as defence in depth. |
| M3 exact: ignore `blankInserted` (blank = 0) | killed (complete-empty-done A3 ×2, property P1) |
| M4 `blankInserted` always false | killed (26 tests) |
| M5 R6 Done insertion guard off | killed (2 R6 tests + property P2) |
| M6 R6 anchors on hidden lines | killed |
| M7 R2 no-adoption refusal off | killed (3 tests; `verifiedUndo` throws `restored task has exactly its completed block`) |
| M7 + size invariant off | killed; `every other task keeps its block` fires |
| M7 + both invariants off | killed (wrong output) |
| M8 R7 residue never removed | killed (5) |
| M9 R7 ignore "Done has other content" | killed |
| M10 R7 ignore "still blank" | killed (desktop deleted the blank ⇒ heading would be removed). A redundant `> done.heading` clause was deleted so this guard carries the load. |
| M12 R13 `trimEnd` | killed (3) |
| M13 R14 prose-first allowed | killed (3) |

## Verify

`pnpm lint`, `pnpm typecheck`, `pnpm test` green (23 files, 345 tests). `packages/domain` typechecks unchanged: it
passes the kernel effect through (`derived.effect`) and maps only named fields into receipts, so the new
`blankInserted` field needs no domain edit. The wire schema `packages/contracts` `CompleteEffect` is a separate
receipt shape and is unaffected.

## Notes for the Lead

1. **R7 residue remains when Done has other content.** Per §4.2 as amended, the blank is removed only when Done
   is otherwise empty. With a Done like `## Done` / `Archive notes.` (no task line), each complete → edit → undo
   cycle still adds one blank line (test `Done has other non-blank content: the blank stays` pins this). Using
   `blankInserted` plus "the line above the block is still blank" would be safe there too; this needs a contract change.
2. The anchor route of semantic Undo does **not** apply the R14 prose rule (only the fallback does): restoring
   next to the recorded anchor recreates the original adjacency, and §4.2 only asks for the no-adoption rule there.
3. `exactUndo` is a test seam exported from `mutations.ts` only. The domain's exact path (parent bytes) is separate.
