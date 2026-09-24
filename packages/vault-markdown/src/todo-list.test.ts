// Parser tests: docs/vault-contract.md §2 (task lines, sections, trailing fields, blocks, read-only reasons).
import { FIXTURE_EOLS, loadVariant } from '@vault-companion/test-vault';
import { describe, expect, it } from 'vitest';
import type { ParsedTask, ParsedTodoList } from './api.ts';
import { parseTodoList } from './todo-list.ts';

function parsed(text: string): ParsedTodoList {
  const r = parseTodoList(text);
  if (!r.ok) throw new Error(r.code);
  return r;
}

const base = parsed(loadVariant('lf', 'todo-list.md'));
const byDescription = (prefix: string): ParsedTask => {
  const t = base.tasks.find((x) => x.description.startsWith(prefix));
  if (!t) throw new Error(`no task ${prefix}`);
  return t;
};

describe('parseTodoList on the synthetic To-Do List', () => {
  it('indexes exactly the top-level #todo task lines in ## Open and ## Done, in file order', () => {
    expect(base.writeBlock).toBeNull();
    expect(base.tasks.map((t) => t.description)).toEqual([
      'Water the plants',
      'Call the bike shop about the gears',
      'Buy rugbrød, smør og æbler at the bakery 🥐',
      'Plan the trip with [[Projects/Summer Trip|the trip plan]]',
      'Sort the receipts',
      'Sort the receipts',
      'Return the library books',
      'Draft the garden plan',
      'Take out the recycling',
      'Renew the parking permit',
      'Book the dentist',
      'Ship the parcel',
      'Pay the water bill',
      'Paint the fence',
      'Read about `- [ ] fake` syntax',
      'Fixed the bike light',
      'Ordered new plates #todo ➕ 2026-09-02 ❌ 2026-09-22 afløst af nyt',
      'Called the landlord #todo ✅ 2026-09-19 (took two tries)',
      'Old cancelled thing',
      'Mid ❌ 2026-09-17 cancelled marker',
      'Open item left in Done',
    ]);
  });

  it('ignores ```tasks / ~~~ fences, %% and <!-- --> comments, frontmatter and inline code (scanLines)', () => {
    const all = base.tasks.map((t) => t.lineText).join('\n');
    for (const hidden of ['Fake task inside the query block', 'Tilde fenced example', 'Commented out task', 'HTML commented task', 'Something #todo']) {
      expect(all).not.toContain(hidden);
    }
    // `## Open` inside the ~~~ fence and the <!-- --> block, `## Done` inside %% — not counted as duplicates.
    expect(base.writeBlock).toBeNull();
  });

  it('skips indented child tasks and lines without #todo (indexed-task rule)', () => {
    expect(base.tasks.some((t) => t.lineText.includes('Child task stays'))).toBe(false);
    expect(base.tasks.some((t) => t.lineText.includes('Not a todo item'))).toBe(false);
  });

  it('records section, status and lineIndex exactly', () => {
    const lines = loadVariant('lf', 'todo-list.md').split('\n');
    for (const t of base.tasks) expect(lines[t.lineIndex]).toBe(t.lineText);
    expect(byDescription('Return the library books')).toMatchObject({ section: 'open', status: 'done', statusChar: 'x', done: '2026-09-05' });
    expect(byDescription('Open item left in Done')).toMatchObject({ section: 'done', status: 'open' });
    expect(byDescription('Paint the fence')).toMatchObject({ statusChar: '/', status: 'other', readOnlyReason: 'refused:unsupported-status' });
  });

  it('parses trailing fields in any order (fields.ts loop)', () => {
    expect(byDescription('Plan the trip')).toMatchObject({
      priority: 'highest',
      due: '2026-10-01',
      scheduled: '2026-09-28',
      start: '2026-09-26',
      created: '2026-09-10',
      tags: ['#todo'],
      links: ['Projects/Summer Trip'],
      readOnlyReason: null,
    });
    expect(byDescription('Water the plants')).toMatchObject({ due: '2026-09-30', created: '2026-09-01', priority: null });
  });

  it('accepts U+FE0F after a priority emoji', () => {
    expect(byDescription('Call the bike shop')).toMatchObject({ priority: 'high', created: '2026-09-02' });
  });

  it('keeps Danish text and 4-byte emoji in the description untouched', () => {
    expect(byDescription('Buy rugbrød').description).toBe('Buy rugbrød, smør og æbler at the bakery 🥐');
  });

  it('strips a trailing block ID first and exposes it (A34)', () => {
    expect(byDescription('Book the dentist')).toMatchObject({ blockId: 'dentist', priority: 'medium', due: '2026-09-25', start: '2026-09-20' });
  });

  it('parses 🆔 and 🔁 / 🏁 as read-only reasons (A7, A34)', () => {
    expect(byDescription('Renew the parking permit')).toMatchObject({ id: 'park01', readOnlyReason: null });
    expect(byDescription('Take out the recycling')).toMatchObject({ recurrence: 'every week', readOnlyReason: 'refused:recurring' });
    expect(byDescription('Ship the parcel')).toMatchObject({ onCompletion: 'delete', readOnlyReason: 'refused:on-completion' });
    expect(byDescription('Pay the water bill').readOnlyReason).toBe('refused:duplicate-field');
  });

  it('does not interpret text after ✅ or ❌ with a reason; interprets ❌ at the end as cancelled (Tasks rule)', () => {
    expect(byDescription('Called the landlord')).toMatchObject({ status: 'done', done: null });
    expect(byDescription('Ordered new plates')).toMatchObject({ status: 'done', cancelled: null });
    expect(byDescription('Old cancelled thing')).toMatchObject({ status: 'cancelled', cancelled: '2026-09-18' });
    expect(byDescription('Mid ❌')).toMatchObject({ status: 'done', done: '2026-09-17', cancelled: null });
    expect(byDescription('Fixed the bike light')).toMatchObject({ status: 'done', done: '2026-09-20' });
  });

  it('computes occurrences per task among indexed lines (locator F2)', () => {
    const receipts = base.tasks.filter((t) => t.description === 'Sort the receipts');
    expect(receipts.map((t) => t.occurrences)).toEqual([2, 2]);
    expect(byDescription('Water the plants').occurrences).toBe(1);
  });

  it('computes block size: children, internal blank line, nested child task (taskBlockEnd)', () => {
    expect(byDescription('Draft the garden plan').blockLineCount).toBe(5);
    expect(byDescription('Read about').blockLineCount).toBe(2);
    expect(byDescription('Water the plants').blockLineCount).toBe(1);
    // Trailing blank lines before a heading are not part of the block.
    expect(parsed(loadVariant('lf', 'todo-empty-done.md')).tasks[0]!.blockLineCount).toBe(2);
  });

  it('reports EOL and final-newline state for LF, CRLF and no-final-newline files', () => {
    for (const eol of FIXTURE_EOLS) {
      const p = parsed(loadVariant(eol, 'todo-list.md'));
      expect(p.eol).toBe(eol === 'crlf' ? '\r\n' : '\n');
      expect(p.hasFinalNewline).toBe(true);
      expect(p.tasks.map((t) => t.lineText)).toEqual(base.tasks.map((t) => t.lineText));
      expect(parsed(loadVariant(eol, 'todo-done-last.md')).hasFinalNewline).toBe(false);
    }
    expect(parsed('## Open\n## Done').eol).toBe('\n');
  });
});

describe('parseTodoList structure and refusals', () => {
  const text = loadVariant('lf', 'todo-list.md');

  it('surfaces duplicate/missing headings as writeBlock refused:structure (reads still work)', () => {
    const dup = parsed(text.replace('## Format reference', '## Done'));
    expect(dup.writeBlock?.code).toBe('refused:structure');
    // The unique `## Open` is still read (for display under a banner); nothing is attributed to an ambiguous Done.
    expect(dup.tasks.length).toBeGreaterThan(0);
    expect(dup.tasks.every((t) => t.section === 'open')).toBe(true);
    expect(parsed(text.replace('## Done\n\n', '## Finished\n\n')).writeBlock?.code).toBe('refused:structure');
  });

  it('surfaces conflict markers as writeBlock refused:vault-conflict, even inside a fence (A29)', () => {
    for (const marker of ['<<<<<<< HEAD', '=======', '>>>>>>> theirs', '||||||| base']) {
      expect(parsed(text.replace('not done\n', `not done\n${marker}\n`)).writeBlock?.code).toBe('refused:vault-conflict');
    }
    // Look-alikes are not markers.
    expect(parsed(text.replace('not done\n', 'not done\n========\n<<<<<<<<\n')).writeBlock).toBeNull();
  });

  it('refuses mixed EOL, lone CR and ill-formed Unicode as unparseable', () => {
    expect(parseTodoList('## Open\r\n## Done\n')).toMatchObject({ ok: false, code: 'refused:mixed-eol' });
    expect(parseTodoList('## Open\r## Done\n')).toMatchObject({ ok: false, code: 'refused:mixed-eol' });
    // CR-only file: no LF at all, so only the lone-CR guard in splitDoc can catch it.
    expect(parseTodoList('## Open\r## Done\r')).toMatchObject({ ok: false, code: 'refused:mixed-eol' });
    expect(parseTodoList('## Open\n\uD800\n## Done\n')).toMatchObject({ ok: false, code: 'refused:encoding' });
  });

  it('an unclosed fence hides the rest of the file (conservative) ⇒ structure refusal, not a guess', () => {
    const r = parsed(text.replace('## Open\n\n', '```\n## Open\n\n'));
    expect(r.writeBlock?.code).toBe('refused:structure');
    expect(r.tasks).toHaveLength(0);
  });

  it('a task line inside Open that opens a %% comment is not indexed, nor anything it hides', () => {
    const r = parsed(text.replace('- [ ] Sort the receipts #todo ➕ 2026-09-04\n', '- [ ] Sort %% the receipts #todo ➕ 2026-09-04\n'));
    expect(r.tasks.some((t) => t.description === 'Water the plants')).toBe(true);
    expect(r.tasks.some((t) => t.description.includes('Sort'))).toBe(false);
    expect(r.writeBlock?.code).toBe('refused:structure');
  });
});
