// Golden mutation tests: docs/vault-contract.md §3–§4, docs/testing.md A1–A8, A26, A29, A31, A34, A35.
// Each test names the production branch whose breakage makes it fail. Expected outputs are hand-specified
// files in packages/test-vault/fixtures/{lf,crlf}/expected, never produced by this kernel.
import { FIXTURE_EOLS, loadVariant, type FixtureEol } from '@vault-companion/test-vault';
import { describe, expect, it } from 'vitest';
import type { CompleteEffect, LocatorInput, MutationOk, Refusal } from './api.ts';
import { captureTask, completeTask, undoCompleteTask } from './mutations.ts';
import { parseTodoList } from './todo-list.ts';

const D = '2026-09-24';
const WATER = '- [ ] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01';
const RUGBROD = '- [ ] Buy rugbrød, smør og æbler at the bakery 🥐 #todo ➕ 2026-09-03';
const PLAN = '- [ ] Plan the trip with [[Projects/Summer Trip|the trip plan]] #todo 🔺 📅 2026-10-01 ⏳ 2026-09-28 🛫 2026-09-26 ➕ 2026-09-10';
const RECEIPTS = '- [ ] Sort the receipts #todo ➕ 2026-09-04';
const GARDEN = '- [ ] Draft the garden plan #todo ➕ 2026-09-05';
const RETURN = '- [x] Return the library books #todo ➕ 2026-09-01 ✅ 2026-09-05';
const IN_DONE = '- [ ] Open item left in Done #todo ➕ 2026-09-12';
const ENDING = 'Ending prose with æøå and a compass 🧭.';

const eolOf = (v: FixtureEol): string => (v === 'crlf' ? '\r\n' : '\n');
const linesOf = (s: string): string[] => s.replace(/^\uFEFF/, '').split(/\r?\n/);

function ok<T>(r: MutationOk<T> | Refusal): MutationOk<T> {
  if (!r.ok) throw new Error(`unexpected refusal ${r.code}`);
  return r;
}

function code(r: MutationOk<unknown> | Refusal): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.code;
}

/** Locator as the read side would build it from `text` (which = 0-based index among identical lines). */
function locate(text: string, lineText: string, which = 0): LocatorInput {
  const parsed = parseTodoList(text);
  if (!parsed.ok) throw new Error(parsed.code);
  const t = parsed.tasks.filter((x) => x.lineText === lineText)[which];
  if (!t) throw new Error(`fixture has no task ${lineText}`);
  return { lineIndex: t.lineIndex, lineText, occurrencesAtRead: t.occurrences, sameRevision: true };
}

const without = (xs: readonly string[], at: number, count: number): string[] => [...xs.slice(0, at), ...xs.slice(at + count)];

/** Replace a whole LF line (the fixture also quotes some task lines inside inline code). */
function swapLine(text: string, line: string, replacement: string): string {
  const needle = `\n${line}\n`;
  if (!text.includes(needle)) throw new Error(`no line ${line}`);
  return text.replace(needle, `\n${replacement}\n`);
}

/** Changed-line set: outside the removed and inserted spans every line is identical and in order. */
function expectOnlyBlockMoved(before: string, after: string, e: CompleteEffect, blankInserted: boolean): void {
  const b = linesOf(before);
  const a = linesOf(after);
  if (e.completedInPlace) {
    expect(a.length).toBe(b.length);
    a.forEach((line, k) => {
      if (k !== e.insertedAt) expect(line).toBe(b[k]);
    });
    return;
  }
  const start = e.insertedAt - (blankInserted ? 1 : 0);
  expect(without(a, start, e.blockLineCount + (blankInserted ? 1 : 0))).toEqual(without(b, e.removedAt, e.blockLineCount));
  expect(a.slice(e.insertedAt + 1, e.insertedAt + e.blockLineCount)).toEqual(
    b.slice(e.removedAt + 1, e.removedAt + e.blockLineCount),
  );
}

interface CompleteCase {
  readonly name: string;
  readonly input: string;
  readonly lineText: string;
  readonly which?: number;
  readonly blockLineCount: number;
  readonly blankInserted?: boolean;
  readonly protects: string;
}

const COMPLETE_CASES: readonly CompleteCase[] = [
  { name: 'complete-water', input: 'todo-list.md', lineText: WATER, blockLineCount: 1, protects: 'A1 move to top of Done; anchor = ## Open heading' },
  { name: 'complete-garden', input: 'todo-list.md', lineText: GARDEN, blockLineCount: 5, protects: 'taskBlockEnd: child block with an internal blank line moves intact' },
  { name: 'complete-child-task', input: 'todo-list.md', lineText: '- [ ] Read about `- [ ] fake` syntax #todo ➕ 2026-09-11', blockLineCount: 2, protects: 'nested child task travels with its parent; inline-code `- [ ]` kept' },
  { name: 'complete-dentist', input: 'todo-list.md', lineText: '- [ ] Book the dentist 🔼 #todo ➕ 2026-09-08 🛫 2026-09-20 📅 2026-09-25 ^dentist', blockLineCount: 1, protects: 'A34 completedLine: ✅ before trailing block ID' },
  { name: 'complete-bike', input: 'todo-list.md', lineText: '- [ ] Call the bike shop about the gears #todo ⏫\uFE0F ➕ 2026-09-02', blockLineCount: 1, protects: 'U+FE0F after priority is kept byte-exact' },
  { name: 'complete-bakery', input: 'todo-list.md', lineText: RUGBROD, blockLineCount: 1, protects: 'Danish + 4-byte emoji description kept byte-exact' },
  { name: 'complete-plan-trip', input: 'todo-list.md', lineText: PLAN, blockLineCount: 1, protects: 'varied field order; ✅ appended after the last field' },
  { name: 'complete-receipts', input: 'todo-list.md', lineText: RECEIPTS, which: 1, blockLineCount: 1, protects: 'A6 resolve: exact line index of a duplicate while the blob is unchanged' },
  { name: 'complete-in-done', input: 'todo-list.md', lineText: IN_DONE, blockLineCount: 1, protects: '§4.1 step 4: open item inside Done completes in place' },
  { name: 'complete-empty-done', input: 'todo-empty-done.md', lineText: '- [ ] Water the plants #todo ➕ 2026-09-01', blockLineCount: 2, blankInserted: true, protects: 'Done without task line: after last non-blank line, one blank line first' },
  { name: 'complete-done-last', input: 'todo-done-last.md', lineText: '- [ ] Call the bike shop #todo ➕ 2026-09-02', blockLineCount: 1, blankInserted: true, protects: 'F16: insert after last line of a file without final newline' },
  { name: 'complete-open-last', input: 'todo-open-last.md', lineText: '- [ ] Water the plants #todo ➕ 2026-09-01', blockLineCount: 1, protects: 'F16: remove last line of a file without final newline; Done above Open' },
];

describe('completeTask golden files (LF and CRLF)', () => {
  for (const eol of FIXTURE_EOLS) {
    for (const c of COMPLETE_CASES) {
      it(`${c.name} [${eol}] — ${c.protects}`, () => {
        const input = loadVariant(eol, c.input);
        const expected = loadVariant(eol, `expected/${c.name}.md`);
        const loc = locate(input, c.lineText, c.which ?? 0);
        const r = ok(completeTask(input, loc, D));
        expect(r.text).toBe(expected);
        expect(r.effect.removedAt).toBe(loc.lineIndex);
        expect(r.effect.blockLineCount).toBe(c.blockLineCount);
        expect(r.effect.openLineText).toBe(c.lineText);
        expect(linesOf(r.text)[r.effect.insertedAt]).toBe(r.effect.completedLineText);
        expectOnlyBlockMoved(input, r.text, r.effect, c.blankInserted ?? false);
      });

      it(`${c.name} [${eol}] — A3 exact-inverse Undo restores the original bytes`, () => {
        const input = loadVariant(eol, c.input);
        const done = ok(completeTask(input, locate(input, c.lineText, c.which ?? 0), D));
        const undo = ok(undoCompleteTask(done.text, { completion: done.effect, unchangedSinceCompletion: true }));
        expect(undo.text).toBe(input);
        expect(undo.effect.openLineText).toBe(c.lineText);
      });
    }
  }
});

describe('completeTask effect', () => {
  it('records anchorBefore / blankLinesAfterAnchor (used by the semantic inverse)', () => {
    const input = loadVariant('lf', 'todo-list.md');
    expect(ok(completeTask(input, locate(input, WATER), D)).effect).toMatchObject({
      anchorBefore: '## Open',
      blankLinesAfterAnchor: 1,
      completedInPlace: false,
      doneDate: D,
    });
    expect(ok(completeTask(input, locate(input, PLAN), D)).effect).toMatchObject({ anchorBefore: RUGBROD, blankLinesAfterAnchor: 1 });
    expect(ok(completeTask(input, locate(input, IN_DONE), D)).effect.completedInPlace).toBe(true);
  });

  it('preserves a BOM (text.ts joinDoc bom branch)', () => {
    for (const eol of FIXTURE_EOLS) {
      const input = '\uFEFF' + loadVariant(eol, 'todo-list.md');
      const r = ok(completeTask(input, locate(input, WATER), D));
      expect(r.text).toBe('\uFEFF' + loadVariant(eol, 'expected/complete-water.md'));
    }
  });

  it('keeps a missing final newline missing when the end is untouched (joinDoc finalNewline=false)', () => {
    for (const eol of FIXTURE_EOLS) {
      const input = loadVariant(eol, 'todo-list.md').slice(0, -eolOf(eol).length);
      const r = ok(completeTask(input, locate(input, WATER), D));
      expect(r.text).toBe(loadVariant(eol, 'expected/complete-water.md').slice(0, -eolOf(eol).length));
    }
  });

  it('rejects a malformed doneDate (assertIsoDate)', () => {
    const input = loadVariant('lf', 'todo-list.md');
    expect(() => completeTask(input, locate(input, WATER), '24-09-2026')).toThrow(TypeError);
  });
});

describe('completeTask locator resolution (§3, ADR-0003)', () => {
  const input = loadVariant('lf', 'todo-list.md');

  it('A13 safe replay: unique text resolves by content after an unrelated edit moved it (resolve step 2)', () => {
    const edited = input.replace('## Open\n\n', '## Open\n\nA note added on the desktop.\n\n');
    const loc = { ...locate(input, WATER), sameRevision: false };
    const r = ok(completeTask(edited, loc, D));
    const expected = loadVariant('lf', 'expected/complete-water.md').replace('## Open\n\n', '## Open\n\nA note added on the desktop.\n\n');
    expect(r.text).toBe(expected);
    expect(r.effect.removedAt).toBe(loc.lineIndex + 2);
  });

  it('A14: edited task line ⇒ conflict:task-changed, no write (resolve step 2, zero matches)', () => {
    const edited = swapLine(input, WATER, WATER.replace('Water', 'Wash'));
    expect(code(completeTask(edited, { ...locate(input, WATER), sameRevision: false }, D))).toBe('conflict:task-changed');
  });

  it('A6: duplicate twins when the blob changed ⇒ conflict:ambiguous (resolve step 3, F2)', () => {
    const edited = input.replace(ENDING, `${ENDING} More.`);
    const loc = { ...locate(input, RECEIPTS, 1), sameRevision: false };
    expect(loc.occurrencesAtRead).toBe(2);
    expect(code(completeTask(edited, loc, D))).toBe('conflict:ambiguous');
  });

  it('A26: twin completed on desktop before the command lands ⇒ conflict:ambiguous even though one twin is left', () => {
    const loc = locate(input, RECEIPTS, 1);
    const desktop = ok(completeTask(input, locate(input, RECEIPTS, 0), '2026-09-23')).text;
    expect(linesOf(desktop).filter((l) => l === RECEIPTS)).toHaveLength(1);
    expect(code(completeTask(desktop, { ...loc, sameRevision: false }, D))).toBe('conflict:ambiguous');
  });

  it('unique text that became duplicated after the read ⇒ conflict:ambiguous (resolve step 2, several matches)', () => {
    const edited = swapLine(input, WATER, `${WATER}\n${WATER}`);
    expect(code(completeTask(edited, { ...locate(input, WATER), sameRevision: false }, D))).toBe('conflict:ambiguous');
  });

  it('same revision but the line at lineIndex differs ⇒ conflict:task-changed (resolve step 1 is exact)', () => {
    const loc = { ...locate(input, RECEIPTS, 1), lineIndex: locate(input, WATER).lineIndex };
    expect(code(completeTask(input, loc, D))).toBe('conflict:task-changed');
  });
});

describe('completeTask refusals (never write)', () => {
  const input = loadVariant('lf', 'todo-list.md');
  const cases: readonly [string, string, string][] = [
    ['A7 🔁 (readOnlyReason recurring)', '- [ ] Take out the recycling #todo 🔁 every week ➕ 2026-09-06', 'refused:recurring'],
    ['A34 🏁 (readOnlyReason on-completion)', '- [ ] Ship the parcel #todo 🏁 delete ➕ 2026-09-09', 'refused:on-completion'],
    ['duplicate 📅 (readOnlyReason duplicate-field)', '- [ ] Pay the water bill #todo 📅 2026-09-20 📅 2026-09-21', 'refused:duplicate-field'],
    ['[/] (readOnlyReason unsupported-status)', '- [/] Paint the fence #todo ➕ 2026-09-10', 'refused:unsupported-status'],
    ['A2 [x] inside Open (status check)', RETURN, 'refused:already-completed'],
  ];
  for (const [what, lineText, expected] of cases) {
    it(`${what} ⇒ ${expected}`, () => {
      expect(code(completeTask(input, locate(input, lineText), D))).toBe(expected);
    });
  }

  it('open task that already carries a trailing ✅ ⇒ refused:duplicate-field (no second ✅)', () => {
    const line = '- [ ] Stray done date #todo ✅ 2026-09-01';
    const text = swapLine(input, WATER, line);
    expect(code(completeTask(text, locate(text, line), D))).toBe('refused:duplicate-field');
  });

  it('block that opens a fence it does not close ⇒ refused:structure (blockSafe)', () => {
    const line = '- [ ] Paste the snippet #todo';
    const text = swapLine(input, WATER, `${line}\n    \`\`\`\ncode at column zero\n\`\`\``);
    expect(code(completeTask(text, locate(text, line), D))).toBe('refused:structure');
  });

  it('A29: conflict markers anywhere ⇒ refused:vault-conflict for complete, undo and capture', () => {
    const done = ok(completeTask(input, locate(input, WATER), D));
    const inject = (s: string) => s.replace(ENDING, `<<<<<<< HEAD\n${ENDING}\n=======\nOther\n>>>>>>> origin/main`);
    const conflicted = inject(input);
    expect(code(completeTask(conflicted, locate(conflicted, WATER), D))).toBe('refused:vault-conflict');
    expect(code(undoCompleteTask(inject(done.text), { completion: done.effect, unchangedSinceCompletion: false }))).toBe(
      'refused:vault-conflict',
    );
    expect(code(captureTask(conflicted, { text: 'Anything', createdDate: D }))).toBe('refused:vault-conflict');
  });

  it('A35: duplicate ## Open / ## Done or missing ## Open ⇒ refused:structure', () => {
    const twoOpen = input.replace(ENDING, `## Open\n\n${ENDING}`);
    const twoDone = input.replace(ENDING, `## Done\n\n${ENDING}`);
    const noOpen = input.replace('## Open\n\n', '## Opened\n\n');
    for (const text of [twoOpen, twoDone]) expect(code(completeTask(text, locate(input, WATER), D))).toBe('refused:structure');
    expect(code(completeTask(noOpen, { ...locate(input, WATER), sameRevision: false }, D))).toBe('refused:structure');
    expect(code(captureTask(noOpen, { text: 'Anything', createdDate: D }))).toBe('refused:structure');
  });

  it('mixed EOL / lone CR ⇒ refused:mixed-eol (splitDoc)', () => {
    const mixed = input.replace('\n', '\r\n');
    const loneCr = input.replace(ENDING, `${ENDING}\rTail`);
    for (const text of [mixed, loneCr]) {
      expect(code(completeTask(text, locate(input, WATER), D))).toBe('refused:mixed-eol');
      expect(code(captureTask(text, { text: 'x', createdDate: D }))).toBe('refused:mixed-eol');
    }
  });

  it('lone surrogate in the file ⇒ refused:encoding (isWellFormed)', () => {
    const bad = input.replace(ENDING, `${ENDING} \uD83D`);
    expect(code(completeTask(bad, locate(input, WATER), D))).toBe('refused:encoding');
  });
});

describe('undoCompleteTask semantic inverse (§4.2 step 2)', () => {
  for (const eol of FIXTURE_EOLS) {
    const n = eolOf(eol);
    const input = loadVariant(eol, 'todo-list.md');
    const unrelated = (s: string) =>
      s.replace(RUGBROD, RUGBROD.replace('at the bakery', 'at the market')).replace(`${ENDING}${n}`, `${ENDING}${n}Added on the desktop.${n}`);

    it(`A4 [${eol}]: after unrelated edits, restores to the heading anchor and keeps the edits`, () => {
      const done = ok(completeTask(input, locate(input, WATER), D));
      const r = ok(undoCompleteTask(unrelated(done.text), { completion: done.effect, unchangedSinceCompletion: false }));
      expect(r.text).toBe(loadVariant(eol, 'expected/undo-after-edits.md'));
    });

    it(`[${eol}] exactInverse only trusts a byte-identical re-completion: a wrong "unchanged" flag falls back to semantic`, () => {
      const done = ok(completeTask(input, locate(input, WATER), D));
      const r = ok(undoCompleteTask(unrelated(done.text), { completion: done.effect, unchangedSinceCompletion: true }));
      expect(r.text).toBe(loadVariant(eol, 'expected/undo-after-edits.md'));
    });

    it(`[${eol}] keeps the recorded blank-line count after a non-heading anchor`, () => {
      const done = ok(completeTask(input, locate(input, PLAN), D));
      const edited = done.text.replace(`${ENDING}${n}`, `${ENDING}${n}Added on the desktop.${n}`);
      const r = ok(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }));
      expect(r.text).toBe(loadVariant(eol, 'expected/undo-blank-count.md'));
    });

    it(`[${eol}] anchor no longer unique in Open ⇒ capture insertion point (top of Open, D4)`, () => {
      const done = ok(completeTask(input, locate(input, GARDEN), D));
      expect(done.effect.anchorBefore).toBe(RETURN);
      const edited = done.text.replace(`${RETURN}${n}`, `${RETURN}${n}${RETURN}${n}`);
      const r = ok(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }));
      expect(r.text).toBe(loadVariant(eol, 'expected/undo-anchor-duplicated.md'));
    });

    it(`[${eol}] completed-in-place: reverts the line in place after unrelated edits (§4.2 step 3)`, () => {
      const done = ok(completeTask(input, locate(input, IN_DONE), D));
      const edited = done.text.replace(`${ENDING}${n}`, `${ENDING}${n}Added on the desktop.${n}`);
      const r = ok(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }));
      expect(r.text).toBe(loadVariant(eol, 'expected/undo-blank-count.md'));
    });
  }

  const input = loadVariant('lf', 'todo-list.md');

  it('never adds blank lines the file no longer has (min(recorded, present))', () => {
    const done = ok(completeTask(input, locate(input, PLAN), D));
    const squeezed = done.text.replace(`${RUGBROD}\n\n${RECEIPTS}`, `${RUGBROD}\n${RECEIPTS}`);
    const r = ok(undoCompleteTask(squeezed, { completion: done.effect, unchangedSinceCompletion: false }));
    expect(r.text).toBe(input.replace(`${RUGBROD}\n\n${PLAN}`, `${RUGBROD}\n${PLAN}`));
  });

  it('A5: completed line edited on desktop ⇒ conflict:task-changed, no write', () => {
    const done = ok(completeTask(input, locate(input, WATER), D));
    const edited = done.text.replace(done.effect.completedLineText, done.effect.completedLineText.replace('Water', 'Wash'));
    expect(code(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }))).toBe('conflict:task-changed');
  });

  it('completed line duplicated in Done ⇒ conflict:ambiguous', () => {
    const done = ok(completeTask(input, locate(input, WATER), D));
    const c = done.effect.completedLineText;
    const edited = done.text.replace(c, `${c}\n${c}`);
    expect(code(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }))).toBe('conflict:ambiguous');
  });

  it('completed line moved back to Open by hand is not found in Done ⇒ conflict:task-changed', () => {
    const done = ok(completeTask(input, locate(input, WATER), D));
    const c = done.effect.completedLineText;
    const edited = done.text.replace(`${c}\n`, '').replace('## Open\n\n', `## Open\n\n${c}\n`);
    expect(code(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }))).toBe('conflict:task-changed');
  });

  it('fallback with a subheading in Open ⇒ refused:structure', () => {
    const done = ok(completeTask(input, locate(input, WATER), D));
    const edited = done.text.replace('## Open\n\n', '### Later\n\n');
    // `## Open` gone ⇒ structure refusal from the start; use a subheading under a surviving Open instead.
    const withSub = done.text.replace('## Open\n\n', '## Open\n\n### Later\n\n');
    expect(code(undoCompleteTask(edited, { completion: done.effect, unchangedSinceCompletion: false }))).toBe('refused:structure');
    const anchorGone = { ...done.effect, anchorBefore: 'A line that is not in the file' };
    expect(code(undoCompleteTask(withSub, { completion: anchorGone, unchangedSinceCompletion: false }))).toBe('refused:structure');
  });

  it('fallback into an empty Open: after the heading with exactly one blank line first (D4 insertion point)', () => {
    const src = loadVariant('lf', 'todo-done-last.md');
    const done = ok(completeTask(src, locate(src, '- [ ] Call the bike shop #todo ➕ 2026-09-02'), D));
    const anchorGone = { ...done.effect, anchorBefore: 'A line that is not in the file' };
    const r = ok(undoCompleteTask(done.text, { completion: anchorGone, unchangedSinceCompletion: false }));
    expect(r.text).toBe('## Open\n\n- [ ] Call the bike shop #todo ➕ 2026-09-02\n## Done\n');
  });
});

describe('captureTask golden files (§4.3–4.4, D4 / ADR-0010: top of Open)', () => {
  const CASES = [
    {
      name: 'capture-full',
      input: 'todo-list.md',
      cmd: { text: 'Call the bike shop', priority: 'high', due: '2026-10-02', context: '[[Projects/Bikes|bikes]]', createdDate: D },
      blank: false,
      protects: 'line format order text, context, #todo, priority, 📅, ➕; before the first non-blank Open line',
    },
    {
      name: 'capture-gap',
      input: 'todo-empty-done.md',
      cmd: { text: 'Water the plants\n  again', createdDate: D },
      blank: false,
      protects: 'top of Open skips the blank after the heading; trailing blank lines of Open untouched; newline sanitised',
    },
    {
      name: 'capture-open-last',
      input: 'todo-open-last.md',
      cmd: { text: 'Pay rent https://bank.example/pay?a=1&b=2', priority: 'low', createdDate: D },
      blank: false,
      protects: 'Open as last section without final newline stays without one; URL untouched',
    },
    {
      name: 'capture-done-last',
      input: 'todo-done-last.md',
      cmd: { text: '  Æble-kage med 🍰  ', priority: 'lowest', createdDate: D },
      blank: false,
      protects: 'heading directly followed by a task: no blank line added; trim; Danish + 4-byte emoji',
    },
    {
      name: 'capture-empty-open',
      input: 'todo-empty-open.md',
      cmd: { text: 'Water the plants', createdDate: D },
      blank: true,
      protects: 'empty Open without blank line: one blank line inserted after the heading',
    },
    {
      name: 'capture-empty-open-blanks',
      input: 'todo-empty-open-blanks.md',
      cmd: { text: 'Water the plants', createdDate: D },
      blank: false,
      protects: 'empty Open with blank lines: the existing blank line is reused, none added',
    },
    {
      name: 'capture-empty-open-eof',
      input: 'todo-empty-open-eof.md',
      cmd: { text: 'Water the plants', createdDate: D },
      blank: true,
      protects: 'empty Open heading at EOF without final newline: blank + task, still no final newline',
    },
  ] as const;
  for (const eol of FIXTURE_EOLS) {
    for (const c of CASES) {
      it(`${c.name} [${eol}] — ${c.protects}`, () => {
        const input = loadVariant(eol, c.input);
        const r = ok(captureTask(input, c.cmd));
        expect(r.text).toBe(loadVariant(eol, `expected/${c.name}.md`));
        const before = linesOf(input);
        const after = linesOf(r.text);
        const at = after.indexOf(r.effect.lineText);
        if (c.blank) expect(after[at - 1]).toBe('');
        expect(without(after, at - (c.blank ? 1 : 0), c.blank ? 2 : 1)).toEqual(before);
      });
    }
  }

  it('first non-blank Open line is indented ⇒ refused:structure (the new task would adopt it as a child)', () => {
    const text = '## Open\n\n    stray indented note\n- [ ] Water the plants #todo\n## Done\n';
    expect(code(captureTask(text, { text: 'x', createdDate: D }))).toBe('refused:structure');
  });
});

describe('captureTask sanitisation and guards', () => {
  const input = loadVariant('lf', 'todo-list.md');
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);

  it('A31: lone CR, CRLF, U+2028/2029, NEL, NUL, C1 and tabs become single spaces; file stays single-EOL', () => {
    for (const eol of FIXTURE_EOLS) {
      const text = loadVariant(eol, 'todo-list.md');
      const r = ok(captureTask(text, { text: `a\rb\r\nc${LS}d${PS}e\u0085f\u0000g\u009Fh\ti\u000Bj`, createdDate: D }));
      expect(r.effect.lineText).toBe(`- [ ] a b c d e f g h i j #todo ➕ ${D}`);
      const parsed = parseTodoList(r.text);
      expect(parsed.ok && parsed.eol).toBe(eolOf(eol));
    }
  });

  it('emoji fields typed inside the text are kept verbatim (QuickAdd behaviour)', () => {
    const r = ok(captureTask(input, { text: 'Pay rent 📅 2026-10-01', createdDate: D }));
    expect(r.effect.lineText).toBe(`- [ ] Pay rent 📅 2026-10-01 #todo ➕ ${D}`);
  });

  it('an unclosed %% or <!-- in the text would hide the rest of the file ⇒ refused:structure (sameReading)', () => {
    expect(code(captureTask(input, { text: 'Call %% later', createdDate: D }))).toBe('refused:structure');
    expect(code(captureTask(input, { text: 'Call <!-- later', createdDate: D }))).toBe('refused:structure');
    expect(ok(captureTask(input, { text: 'Call %%quietly%% later', createdDate: D })).effect.lineText).toBe(
      `- [ ] Call %%quietly%% later #todo ➕ ${D}`,
    );
  });

  it('subheading inside ## Open ⇒ refused:structure (openHasSubheading)', () => {
    const text = input.replace(`${WATER}\n`, `${WATER}\n\n### Later\n\n`);
    expect(code(captureTask(text, { text: 'x', createdDate: D }))).toBe('refused:structure');
    // Completion is not blocked by a subheading.
    expect(completeTask(text, locate(text, WATER), D).ok).toBe(true);
  });

  it('empty after sanitisation throws (no "invalid" RefusalCode in api.ts)', () => {
    expect(() => captureTask(input, { text: ` \u0000${LS} `, createdDate: D })).toThrow(RangeError);
  });

  it('lone surrogate in the capture text ⇒ refused:encoding', () => {
    expect(code(captureTask(input, { text: 'Bad \uDE00 text', createdDate: D }))).toBe('refused:encoding');
  });

  it('context with a line break or of the wrong shape throws (assertContext)', () => {
    expect(() => captureTask(input, { text: 'x', context: '[[a]]\n- [ ] injected #todo', createdDate: D })).toThrow(TypeError);
    expect(() => captureTask(input, { text: 'x', context: `[[a${LS}b]]`, createdDate: D })).toThrow(TypeError);
    expect(() => captureTask(input, { text: 'x', context: 'javascript:alert(1)', createdDate: D })).toThrow(TypeError);
    expect(() => captureTask(input, { text: 'x', createdDate: '2026-9-24' })).toThrow(TypeError);
  });

  it('A8 + undo interplay: capture then complete the captured task then exact-undo restores the capture result', () => {
    const captured = ok(captureTask(input, { text: 'Water the plants again', createdDate: D }));
    const done = ok(completeTask(captured.text, locate(captured.text, captured.effect.lineText), D));
    const undo = ok(undoCompleteTask(done.text, { completion: done.effect, unchangedSinceCompletion: true }));
    expect(undo.text).toBe(captured.text);
  });
});
