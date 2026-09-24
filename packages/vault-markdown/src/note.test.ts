// Note capture: docs/vault-contract.md §4.5, docs/testing.md A9, A30, A31.
import { describe, expect, it } from 'vitest';
import { checkNoteInput, noteFileName, renderNote } from './note.ts';

const D = '2026-09-24';
const LS = String.fromCharCode(0x2028);

describe('noteFileName title (noteTitle)', () => {
  const title = (text: string): string => noteFileName(text, D, []).slice('Inbox/'.length, -` - ${D}.md`.length);

  it('uses the first non-empty line, sanitised', () => {
    expect(noteFileName('Call the bike shop\nabout the gears', D, [])).toBe(`Inbox/Call the bike shop - ${D}.md`);
    expect(title('\n\n   \r\n\tSecond line title\nThird')).toBe('Second line title');
    expect(title(`First${LS}still first line?`)).toBe('First');
    expect(title('Tabs\tand\u0007bells   collapse')).toBe('Tabs and bells collapse');
  });

  it('removes \\ / : * ? " < > | # ^ [ ] (and %, which the path policy rejects)', () => {
    expect(title('a\\b/c:d*e?f"g<h>i|j#k^l[m]n%o')).toBe('abcdefghijklmno');
    expect(title('Plan: [[Trip]] #travel')).toBe('Plan Trip travel');
  });

  it('removes leading dots (hidden files) and empty ⇒ Note', () => {
    expect(title('...hidden plan')).toBe('hidden plan');
    expect(title('. . .x')).toBe('x');
    for (const empty of ['', '   \n\n', '###', '...', ':::', '\u0000']) expect(title(empty)).toBe('Note');
  });

  it('truncates to 60 code points at a word boundary', () => {
    const words = 'Water the plants and then call the bike shop about the gears again today';
    expect(title(words)).toBe('Water the plants and then call the bike shop about the gears');
    expect(Array.from(title(words)).length).toBeLessThanOrEqual(60);
    const exact = `${'a'.repeat(60)} tail`;
    expect(title(exact)).toBe('a'.repeat(60));
    expect(title('b'.repeat(70))).toBe('b'.repeat(60));
  });

  it('counts code points, not UTF-16 units (4-byte emoji)', () => {
    expect(title('🥐'.repeat(61))).toBe('🥐'.repeat(60));
    expect(title(`æøå ${'🧭'.repeat(58)} x`)).toBe('æøå');
  });

  it('keeps Danish letters and NFC-normalises the path', () => {
    expect(title('Æbler og rødgrød')).toBe('Æbler og rødgrød');
    expect(title('Café plan')).toBe('Café plan');
  });
});

describe('noteFileName collisions (review F7)', () => {
  it('appends (2), (3)… for taken names', () => {
    expect(noteFileName('Call', D, [`Call - ${D}.md`])).toBe(`Inbox/Call - ${D} (2).md`);
    expect(noteFileName('Call', D, [`Call - ${D}.md`, `Call - ${D} (2).md`])).toBe(`Inbox/Call - ${D} (3).md`);
    expect(noteFileName('Call', D, [`Other - ${D}.md`])).toBe(`Inbox/Call - ${D}.md`);
  });

  it('A30: case-variant and NFD-variant names are taken; Inbox/ prefixes accepted', () => {
    expect(noteFileName('Call the shop', D, [`CALL THE SHOP - ${D}.MD`])).toBe(`Inbox/Call the shop - ${D} (2).md`);
    expect(noteFileName('Café', D, [`Inbox/Café - ${D}.md`])).toBe(`Inbox/Café - ${D} (2).md`);
    expect(noteFileName('Øl', D, [`øl - ${D}.md`])).toBe(`Inbox/Øl - ${D} (2).md`);
  });
});

describe('renderNote (§4.5 content)', () => {
  it('A9: frontmatter, blank line, verbatim text with CRLF and lone CR → LF, URLs untouched', () => {
    const text = 'Idea for the garden\r\nSee https://example.org/a_b?c=1&d=%20x#frag\rand *this*  \n\n  indented';
    expect(renderNote({ text, date: D, capturedAt: '2026-09-24T21:05:00+02:00' })).toBe(
      [
        '---',
        `date: ${D}`,
        'created: 2026-09-24T21:05:00+02:00',
        'type: inbox-note',
        'status: open',
        'source: vault-companion',
        'tags:',
        '  - inbox',
        '---',
        '',
        'Idea for the garden',
        'See https://example.org/a_b?c=1&d=%20x#frag',
        'and *this*  ',
        '',
        '  indented',
        '',
      ].join('\n'),
    );
  });

  it('A31: context is a double-quoted, escaped YAML scalar ([[a|b]], ": ", quotes, backslash)', () => {
    const out = renderNote({ text: 'x\n', date: D, capturedAt: '2026-09-24T19:05:00Z', context: '[[a|b "c": d\\e]]' });
    expect(out).toContain('\n  - inbox\ncontext: "[[a|b \\"c\\": d\\\\e]]"\n---\n\nx\n');
    expect(out.endsWith('x\n')).toBe(true);
    expect(out).not.toContain('x\n\n');
  });

  it('escapes non-printables if they ever reach the YAML scalar (yamlDoubleQuoted)', async () => {
    const { yamlDoubleQuoted } = await import('./note.ts');
    expect(yamlDoubleQuoted(`a\tb\u0085c${LS}d\u2029e\u007F\uFEFF`)).toBe('"a\\x09b\\Nc\\Ld\\Pe\\x7f\\ufeff"');
  });

  it('keeps an existing trailing newline single and adds one when missing', () => {
    const at = '2026-09-24T21:05:00+02:00';
    expect(renderNote({ text: 'a\r\n', date: D, capturedAt: at }).endsWith('\n\na\n')).toBe(true);
    expect(renderNote({ text: 'a', date: D, capturedAt: at }).endsWith('\n\na\n')).toBe(true);
    expect(renderNote({ text: 'a', date: D, capturedAt: at })).not.toContain('\r');
  });

  it('checkNoteInput returns typed refusals for every input renderNote would reject', () => {
    const at = '2026-09-24T21:05:00+02:00';
    const good = { text: 'a', date: D, capturedAt: at };
    expect(checkNoteInput(good)).toBeNull();
    expect(checkNoteInput({ ...good, context: '[[a|b "c": d]]' })).toBeNull();
    expect(checkNoteInput({ ...good, text: 'a\u0000b' })?.code).toBe('invalid');
    expect(checkNoteInput({ ...good, text: 'a\uD800' })?.code).toBe('refused:encoding');
    expect(checkNoteInput({ ...good, context: '[[a]]\nevil: true' })?.code).toBe('invalid');
    expect(checkNoteInput({ ...good, capturedAt: '2026-09-24 21:05' })?.code).toBe('invalid');
    expect(checkNoteInput({ ...good, date: '24/09/2026' })?.code).toBe('invalid');
  });

  it('renderNote/noteFileName (string return type) still throw on the same inputs (never writes a broken note)', () => {
    const at = '2026-09-24T21:05:00+02:00';
    expect(() => renderNote({ text: 'a\u0000b', date: D, capturedAt: at })).toThrow(TypeError);
    expect(() => renderNote({ text: 'a\uD800', date: D, capturedAt: at })).toThrow(TypeError);
    expect(() => renderNote({ text: 'a', date: D, capturedAt: at, context: '[[a]]\nevil: true' })).toThrow(TypeError);
    expect(() => renderNote({ text: 'a', date: D, capturedAt: '2026-09-24 21:05' })).toThrow(TypeError);
    expect(() => renderNote({ text: 'a', date: '24/09/2026', capturedAt: at })).toThrow(TypeError);
    expect(() => noteFileName('a', '2026-9-24', [])).toThrow(TypeError);
  });
});
