// Phase 1 gate regressions (docs/reviews/phase-1-reconciliation.md, owner K2). Each test is a reviewer's concrete
// reproduction (R-ids: phase-1-review-opus.md, A-ids: phase-1-review-astra.md) and names the guard it protects.
import { FIXTURE_EOLS, loadVariant } from '@vault-companion/test-vault';
import { describe, expect, it } from 'vitest';
import type { LocatorInput, MutationOk, Refusal } from './api.ts';
import { captureTask, completeTask, exactUndo, undoCompleteTask } from './mutations.ts';
import { parseTodoList } from './todo-list.ts';

const D = '2026-09-24';
const NBSP = String.fromCharCode(0xa0);
const A = '- [ ] A #todo';
const B = '- [ ] B #todo';

function ok<T>(r: MutationOk<T> | Refusal): MutationOk<T> {
  if (!r.ok) throw new Error(`unexpected refusal ${r.code}`);
  return r;
}

function code(r: MutationOk<unknown> | Refusal): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.code;
}

function locate(text: string, lineText: string): LocatorInput {
  const parsed = parseTodoList(text);
  if (!parsed.ok) throw new Error(parsed.code);
  const t = parsed.tasks.find((x) => x.lineText === lineText);
  if (!t) throw new Error(`no task ${lineText}`);
  return { lineIndex: t.lineIndex, lineText, occurrencesAtRead: t.occurrences, sameRevision: true };
}

function sectionOf(text: string, lineText: string): string | undefined {
  const parsed = parseTodoList(text);
  return parsed.ok ? parsed.tasks.find((t) => t.lineText === lineText)?.section : undefined;
}

const complete = (text: string, lineText: string) => ok(completeTask(text, locate(text, lineText), D));
const semanticUndo = (text: string, done: ReturnType<typeof complete>) =>
  undoCompleteTask(text, { completion: done.effect, unchangedSinceCompletion: false });

describe('R1/A1: exact inverse accepts only a candidate that reproduces the whole effect', () => {
  const task = '- [ ] Water the plants #todo ➕ 2026-09-01';

  for (const eol of FIXTURE_EOLS) {
    const base = loadVariant(eol, 'todo-done-above-open.md');
    const n = eol === 'crlf' ? '\r\n' : '\n';
    const variants: readonly [string, string][] = [
      ['no final newline', base.slice(0, -n.length)],
      ['BOM', '﻿' + base],
      ['BOM, no final newline', '﻿' + base.slice(0, -n.length)],
    ];
    for (const [what, input] of variants) {
      it(`Done above Open [${eol}, ${what}]: exact Undo restores the original bytes and the task is back in Open`, () => {
        const done = complete(input, task);
        expect(done.effect.completedInPlace).toBe(false);
        const undo = ok(undoCompleteTask(done.text, { completion: done.effect, unchangedSinceCompletion: true }));
        expect(undo.text).toBe(input);
        expect(sectionOf(undo.text, task)).toBe('open');
      });
    }
  }

  it('an effect that does not fit the file is never trusted: the in-place reading is declined (whole-effect check)', () => {
    const input = '## Done\n## Open\n- [ ] A #todo\n';
    const done = complete(input, A);
    // With blankInserted flipped, the only candidate is the in-place reading: same bytes, same insertedAt,
    // but re-completing it yields completedInPlace = true. It must be declined, not written.
    const wrong = { ...done.effect, blankInserted: false };
    expect(exactUndo(done.text, wrong)).toBeNull();
    expect(exactUndo(done.text, done.effect)?.text).toBe(input);
  });

  it("reviewers' minimal input (Astra, no final newline) is restored exactly", () => {
    const input = '## Done\n## Open\n- [ ] A #todo';
    const done = complete(input, A);
    expect(done.text).toBe(`## Done\n\n- [x] A #todo ✅ ${D}\n## Open`);
    expect(ok(undoCompleteTask(done.text, { completion: done.effect, unchangedSinceCompletion: true })).text).toBe(input);
  });
});

describe('R2/A5: semantic Undo never adopts lines (no-adoption rule, §4.2)', () => {
  it('anchor gained a child after completion ⇒ refused:structure (Opus R2)', () => {
    const input = `## Open\n${A}\n${B}\n## Done\n`;
    const done = complete(input, B);
    const edited = done.text.replace(`${A}\n`, `${A}\n    - child of A\n`);
    expect(code(semanticUndo(edited, done))).toBe('refused:structure');
  });

  it('indented stray line right after the heading anchor ⇒ refused:structure (Opus R2 variant)', () => {
    const input = `## Open\n${B}\n${A}\n## Done\n`;
    const done = complete(input, B);
    expect(done.effect.anchorBefore).toBe('## Open');
    const edited = done.text.replace('## Open\n', '## Open\n    indented stray\n');
    expect(code(semanticUndo(edited, done))).toBe('refused:structure');
  });

  it('indented desktop text after the heading and its recorded blank line ⇒ refused:structure (Astra A5)', () => {
    const input = `## Open\n\n${A}\n## Done\n`;
    const done = complete(input, A);
    expect(done.effect.blankLinesAfterAnchor).toBe(1);
    const edited = done.text.replace('## Open\n\n', '## Open\n\n  desktop section context\n\n');
    expect(code(semanticUndo(edited, done))).toBe('refused:structure');
  });

  it('restored task takes exactly the child lines its completed block has now (edited on desktop)', () => {
    const input = `## Open\n${A}\n${B}\n    - first\n## Done\n`;
    const done = complete(input, B);
    const edited = done.text.replace('    - first\n', '    - first\n    - second\n');
    const r = ok(semanticUndo(edited, done));
    expect(r.text).toBe(`## Open\n${A}\n${B}\n    - first\n    - second\n## Done\n`);
    const parsed = parseTodoList(r.text);
    expect(parsed.ok && parsed.tasks.map((t) => [t.lineText, t.blockLineCount])).toEqual([
      [A, 1],
      [B, 3],
    ]);
  });
});

describe('R7: blankInserted and the blank residue after semantic Undo', () => {
  it('Done below Open: the blank completion inserted into an empty Done is removed', () => {
    const input = `# List\n## Open\n${A}\n${B}\n## Done\n`;
    const done = complete(input, B);
    expect(done.effect.blankInserted).toBe(true);
    const edited = done.text.replace('# List', '# My list');
    expect(ok(semanticUndo(edited, done)).text).toBe(input.replace('# List', '# My list'));
  });

  it('Done above Open: the blank is removed and the restore position shifts with it', () => {
    const input = `# List\n## Done\n## Open\n${A}\n${B}\n`;
    const done = complete(input, B);
    const edited = done.text.replace('# List', '# My list');
    expect(ok(semanticUndo(edited, done)).text).toBe(input.replace('# List', '# My list'));
  });

  it('blank deleted on the desktop: the line above the block is the heading and is kept ("still blank")', () => {
    const input = `## Open\n${A}\n${B}\n## Done\n`;
    const done = complete(input, B);
    const edited = done.text.replace('## Done\n\n', '## Done\n');
    expect(ok(semanticUndo(edited, done)).text).toBe(input);
  });

  it('Done has other non-blank content: the blank stays (§4.2 limits removal to an otherwise empty Done)', () => {
    const input = `# List\n## Open\n${A}\n${B}\n## Done\nArchive notes.\n`;
    const done = complete(input, B);
    expect(done.effect.blankInserted).toBe(true);
    const edited = done.text.replace('# List', '# My list');
    expect(ok(semanticUndo(edited, done)).text).toBe(`# My list\n## Open\n${A}\n${B}\n## Done\nArchive notes.\n\n`);
  });

  it('no blank inserted (Done already had a task) ⇒ blankInserted false and nothing extra removed', () => {
    const input = `# List\n## Open\n${A}\n${B}\n## Done\n\n- [x] C #todo\n`;
    const done = complete(input, B);
    expect(done.effect.blankInserted).toBe(false);
    const edited = done.text.replace('# List', '# My list');
    expect(ok(semanticUndo(edited, done)).text).toBe(input.replace('# List', '# My list'));
  });
});

describe('R6: reachable structure problems are typed refusals, never throws', () => {
  it('Done ends inside an unclosed fence ⇒ complete refused:structure', () => {
    const input = `## Open\n${A}\n## Done\n\`\`\`\nlog\n`;
    expect(code(completeTask(input, locate(input, A), D))).toBe('refused:structure');
  });

  it('Done ends inside an unclosed %% comment ⇒ complete refused:structure', () => {
    const input = `## Open\n${A}\n## Done\n%% archived\nlog\n`;
    expect(code(completeTask(input, locate(input, A), D))).toBe('refused:structure');
  });

  it('the only copy of the anchor moved into a fence: anchors count only on visible lines ⇒ capture point', () => {
    const P = '- [ ] P #todo';
    const Q = '- [ ] Q #todo';
    const input = `## Open\n${Q}\n${P}\n${B}\n## Done\n`;
    const done = complete(input, B);
    expect(done.effect.anchorBefore).toBe(P);
    const edited = done.text.replace(`${P}\n`, `\`\`\`\n${P}\n\`\`\`\n`);
    expect(ok(semanticUndo(edited, done)).text).toBe(`## Open\n${B}\n${Q}\n\`\`\`\n${P}\n\`\`\`\n## Done\n`);
  });
});

describe('R13: only spaces and tabs are trimmed before ✅', () => {
  it('NBSP after a block ID is kept and stays after the block ID', () => {
    const line = `- [ ] A #todo ^abc${NBSP}`;
    const done = complete(`## Open\n${line}\n## Done\n`, line);
    expect(done.effect.completedLineText).toBe(`- [x] A #todo ✅ ${D} ^abc${NBSP}`);
  });

  it('trailing tab after the NBSP is trimmed, the NBSP is kept', () => {
    const line = `- [ ] A #todo ^abc${NBSP}\t`;
    const done = complete(`## Open\n${line}\n## Done\n`, line);
    expect(done.effect.completedLineText).toBe(`- [x] A #todo ✅ ${D} ^abc${NBSP}`);
  });

  it('NBSP without a block ID is kept before ✅ (unchanged behaviour)', () => {
    const line = `- [ ] A #todo${NBSP} `;
    const done = complete(`## Open\n${line}\n## Done\n`, line);
    expect(done.effect.completedLineText).toBe(`- [x] A #todo${NBSP} ✅ ${D}`);
  });
});

describe('R14: capture refuses when the first non-blank Open line is not a list item (§4.4)', () => {
  it('prose directly after the heading ⇒ refused:structure', () => {
    const input = `## Open\nSome prose line\n${A}\n## Done\n`;
    expect(code(captureTask(input, { text: 'new', createdDate: D }))).toBe('refused:structure');
  });

  it('prose after a blank line ⇒ refused:structure', () => {
    const input = `## Open\n\nSome prose line\n\n${A}\n## Done\n`;
    expect(code(captureTask(input, { text: 'new', createdDate: D }))).toBe('refused:structure');
  });

  it('a plain (non-task) list item first is fine: the new task is its sibling', () => {
    const input = `## Open\n- plain item\n${A}\n## Done\n`;
    expect(ok(captureTask(input, { text: 'new', createdDate: D })).text).toBe(
      `## Open\n- [ ] new #todo ➕ ${D}\n- plain item\n${A}\n## Done\n`,
    );
  });

  it('semantic Undo fallback uses the same rule (§4.2 → §4.4)', () => {
    const input = `## Open\n${B}\n${A}\n## Done\n`;
    const done = complete(input, B);
    const edited = done.text.replace('## Open\n', '## Open\nSome prose line\n');
    const anchorGone = { ...done.effect, anchorBefore: 'A line that is not in the file' };
    expect(code(undoCompleteTask(edited, { completion: anchorGone, unchangedSinceCompletion: false }))).toBe('refused:structure');
  });
});
