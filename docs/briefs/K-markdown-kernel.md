# Brief K — Markdown safety kernel + synthetic fixtures

Type: **implementation**. Branch `agent/markdown-kernel`, worktree `C:\Dev\vault-companion-worktrees\markdown-kernel`.
Commit your work on that branch; the Lead reviews and merges.

## Objective

Implement the pure kernel in `packages/vault-markdown` exactly as specified in `docs/vault-contract.md`
§2–§5, against the already-fixed API in `packages/vault-markdown/src/api.ts` and the stub signatures in
`todo-list.ts`, `mutations.ts`, `note.ts`. Build the synthetic fixture family in `packages/test-vault`.

## May change

`packages/vault-markdown/**` (except `src/api.ts` — propose API changes in your report instead),
`packages/test-vault/**`, root `tsconfig.json` references for these two packages.

## Must not change

`docs/**` except your report file (report spec gaps instead), `packages/contracts`, `packages/domain`, `packages/github`, `apps/**`,
root config other than the tsconfig reference. Never read `C:\Dev\vault-companion-vault-reference`:
fixture shape requirements are in `docs/testing.md#fixture-requirements` and `docs/discovery/phase-0-findings.md`.
All fixture text is invented.

## Required

- Fixtures as **files** under `packages/test-vault/fixtures/` (the repo marks them `-text`: bytes are exact).
  LF and CRLF variants generated from one LF source by a small builder, plus the golden **expected** outputs as
  files. Export helpers `loadFixture(name): string` from `packages/test-vault/src/index.ts` (Node fs is fine there).
- Golden tests: for each mutation case, `expect(actual).toBe(expectedFileContent)` on the whole file, for LF and CRLF.
  Also assert the changed-line set: every line outside the intended span is identical and in order.
- Cover docs/testing.md A1–A9 and the kernel parts of A26, A29, A30 (`noteFileName` casefold/NFC), A31, A34, A35 plus:
  exact-inverse Undo restores original bytes; semantic-inverse Undo after an unrelated edit restores to the recorded
  non-blank anchor with the recorded blank-line count; `occurrences` computed per task; `writeBlock` for duplicate
  headings and conflict markers; comment blocks (`%%`, `<!-- -->`) and `~~~` fences ignored; also: fenced ```tasks block lines ignored; inline-code `- [ ]` in
  prose ignored; `[x]` inside Open; Done without any task line; no final newline; U+FE0F after priority emoji;
  duplicate identical lines (sameRevision true → exact; false → `conflict:ambiguous`); child block with an internal
  blank line moved intact; `🔁` → `refused:recurring` and `readOnlyReason`; duplicate field → `refused:duplicate-field`;
  mixed EOL → `refused:mixed-eol`; lone `\r`; BOM preserved; Danish + 4-byte emoji in descriptions; trailing text after
  `✅` is not interpreted; `❌ date reason` is not interpreted as cancelled (Tasks rule) while `❌ date` at end is;
  capture into an Open section whose last line is followed by 2 blank lines; missing `## Open` → `refused:structure`;
  note filename sanitisation (`\/:*?"<>|#^[]`, leading dots, control chars, 60-code-point word-boundary truncation,
  empty → `Note`), collision attempt suffix, verbatim body incl. CRLF→LF, URLs untouched.
- For every test, the test name or a comment states which production branch it protects. No test may pass
  against a stub that returns the input unchanged.

## Commands you must run

`pnpm install`, `pnpm lint`, `pnpm typecheck`, `pnpm test` — all green before you report.

## Report

Write `docs/reviews/K-report.md`: what was implemented, spec gaps/ambiguities you resolved (and how), any
proposed `api.ts` change, test count. Reply in the terminal with one line: `K DONE <commit-sha> — docs/reviews/K-report.md`.
