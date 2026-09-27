// Inbox note body edit (ADR-0022): exact golden bytes. Synthetic notes only.
import { describe, expect, it } from 'vitest';
import { editNoteBody, noteFrontmatterLength, splitNote } from './note-edit.ts';

const BOM = String.fromCharCode(0xfeff);
const FM = '---\ndate: 2026-09-27\ntype: inbox-note\n---\n';

function edited(text: string, body: string): string {
  const r = editNoteBody(text, body);
  if (!r.ok) throw new Error(`refused: ${r.code}`);
  return r.text;
}
const code = (text: string, body: string) => {
  const r = editNoteBody(text, body);
  return r.ok ? 'ok' : r.code;
};

describe('splitNote', () => {
  it('splits frontmatter (incl. its EOL) from the body', () => {
    expect(splitNote(`${FM}Buy seeds\n`)).toEqual({ bom: false, frontmatter: FM, body: 'Buy seeds\n', eol: '\n', finalNewline: true });
  });
  it('CRLF, BOM, no final newline', () => {
    const fm = '---\r\na: 1\r\n---\r\n';
    expect(splitNote(`${BOM}${fm}x\r\ny`)).toEqual({ bom: true, frontmatter: fm, body: 'x\r\ny', eol: '\r\n', finalNewline: false });
  });
  it('no frontmatter: unclosed or not on the first line', () => {
    expect(splitNote('---\nnot closed\n')).toMatchObject({ frontmatter: '', body: '---\nnot closed\n' });
    expect(splitNote('text\n---\na\n---\n')).toMatchObject({ frontmatter: '', body: 'text\n---\na\n---\n' });
  });
  it('frontmatter only, closed on the last line without a break', () => {
    expect(splitNote('---\na: 1\n---')).toMatchObject({ frontmatter: '---\na: 1\n---', body: '', finalNewline: false });
  });
  it('mixed EOL ⇒ refused:mixed-eol (the read split stays EOL-agnostic)', () => {
    expect(splitNote('---\r\na\n---\nx\n')).toMatchObject({ ok: false, code: 'refused:mixed-eol' });
    expect(noteFrontmatterLength('---\r\na\n---\nx\n')).toBe('---\r\na\n---\n'.length);
  });
});

describe('editNoteBody golden bytes', () => {
  it('LF with frontmatter: frontmatter byte-identical, body replaced', () => {
    expect(edited(`${FM}Old body\n`, 'New body\nsecond line\n')).toBe(`${FM}New body\nsecond line\n`);
  });

  it('CRLF file: frontmatter kept, body typed with LF becomes CRLF', () => {
    const fm = '---\r\ndate: 2026-09-27\r\n---\r\n';
    expect(edited(`${fm}Old\r\nbody\r\n`, 'New\nbody\n\nend')).toBe(`${fm}New\r\nbody\r\n\r\nend\r\n`);
    // A lone CR or CRLF typed into the editor is a line break too.
    expect(edited(`${fm}Old\r\n`, 'a\r\nb\rc')).toBe(`${fm}a\r\nb\r\nc\r\n`);
  });

  it('BOM kept', () => {
    expect(edited(`${BOM}${FM}Old\n`, 'New\n')).toBe(`${BOM}${FM}New\n`);
    expect(edited(`${BOM}Old`, 'New')).toBe(`${BOM}New`);
  });

  it('no frontmatter', () => {
    expect(edited('Just a thought\n', 'A better thought\n')).toBe('A better thought\n');
  });

  it('frontmatter only: body added after it; closed without a break gets one', () => {
    expect(edited(FM, 'First words')).toBe(`${FM}First words\n`);
    expect(edited('---\na: 1\n---', 'First words')).toBe('---\na: 1\n---\nFirst words');
  });

  it('no final newline stays without one (trailing breaks typed in the editor dropped)', () => {
    expect(edited(`${FM}Old`, 'New\n\n')).toBe(`${FM}New`);
    expect(edited('Old', 'New')).toBe('New');
  });

  it('final newline kept, and a missing one in the editor is restored; blank trailing lines survive', () => {
    expect(edited(`${FM}Old\n`, 'New')).toBe(`${FM}New\n`);
    expect(edited(`${FM}Old\n`, 'New\n\n')).toBe(`${FM}New\n\n`);
  });

  it('body with --- lines inside (thematic break) is ordinary body text', () => {
    expect(edited(`${FM}Intro\n---\nMore\n`, 'Intro\n---\nChanged\n---\n')).toBe(`${FM}Intro\n---\nChanged\n---\n`);
    const r = splitNote(`${FM}Intro\n---\nMore\n`);
    expect(r).toMatchObject({ frontmatter: FM, body: 'Intro\n---\nMore\n' });
  });

  it('clearing the body keeps the frontmatter', () => {
    expect(edited(`${FM}Old\n`, '')).toBe(FM);
  });
});

describe('editNoteBody refusals', () => {
  it('identical result ⇒ refused:invalid-edit', () => {
    expect(code(`${FM}Same\n`, 'Same\n')).toBe('refused:invalid-edit');
    expect(code(`${FM}Same\n`, 'Same')).toBe('refused:invalid-edit');
    expect(code('---\r\na\r\n---\r\nSame\r\n', 'Same\n')).toBe('refused:invalid-edit');
  });

  it('conflict markers anywhere in the current file ⇒ refused:vault-conflict', () => {
    expect(code(`${FM}<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n`, 'Resolved\n')).toBe('refused:vault-conflict');
    expect(code('---\na: 1\n=======\n---\nx\n', 'y')).toBe('refused:vault-conflict');
    // Seven '=' followed by text is not a marker.
    expect(code(`${FM}======= heading-ish\n`, 'x')).toBe('ok');
  });

  it('mixed EOL ⇒ refused:mixed-eol', () => {
    expect(code('---\na\n---\r\nOld\n', 'New')).toBe('refused:mixed-eol');
    expect(code('Old\rline\n', 'New')).toBe('refused:mixed-eol');
  });

  it('malformed new text ⇒ refused:encoding / invalid', () => {
    expect(code(`${FM}Old\n`, `bad ${String.fromCharCode(0xd800)}`)).toBe('refused:encoding');
    expect(code(`${FM}Old\n`, `nul ${String.fromCharCode(0)}`)).toBe('invalid');
  });
});
