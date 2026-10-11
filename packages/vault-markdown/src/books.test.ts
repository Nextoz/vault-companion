import { expect, it } from 'vitest';
import * as kernel from './books.ts';

const fixture =
  '---\n' +
  'type: book\n' +
  'status: reading\n' +
  'author: Synthetic Author\n' +
  'totalPages: 100\n' +
  '---\n' +
  '# Synthetic Book\n' +
  '\n' +
  '## Progress\n' +
  '- 2026-10-01: p. 10\n' +
  '\n' +
  '## Reflections\n' +
  '### 2026-10-02\n' +
  'First reflection\n';
const progressLine = '- 2026-10-05: p. 40';
const created =
  '---\n' +
  'type: book\n' +
  'status: reading\n' +
  'author: Synthetic Author\n' +
  'totalPages: 100\n' +
  '---\n' +
  '# Synthetic Book\n' +
  '\n' +
  '## Progress\n' +
  '\n' +
  '## Reflections\n';

it('creates the canonical note', () => {
  expect(kernel.createBookNote({ title: 'Synthetic Book', author: 'Synthetic Author', totalPages: 100 })).toBe(created);
  const parsed = kernel.parseBookNote(kernel.createBookNote({ title: 'T', author: '', totalPages: 3 }));
  expect(parsed).toMatchObject({
    ok: true,
    frontmatter: { type: 'book', author: '', totalPages: 3, status: 'reading' },
    progress: [],
    reflections: [],
    currentPage: 0,
    lastRead: null,
  });
});

it('appends exactly one progress line and leaves every other byte untouched', () => {
  const r = kernel.appendProgress(fixture, { date: '2026-10-05', page: 40 });
  if (!r.ok) throw new Error(r.code);
  expect(r.text).toBe(fixture.replace('- 2026-10-01: p. 10\n', '- 2026-10-01: p. 10\n' + progressLine + '\n'));
  expect(r.text.replace(progressLine + '\n', '')).toBe(fixture);
  expect(r.effect).toMatchObject({ kind: 'book', op: 'logged', lineText: progressLine });
  const parsed = kernel.parseBookNote(r.text);
  expect(parsed).toMatchObject({ ok: true, currentPage: 40, lastRead: '2026-10-05', progress: [{ date: '2026-10-01', page: 10 }, { date: '2026-10-05', page: 40 }] });
});

it('keeps BOM, CRLF and final-newline state when appending', () => {
  const crlf = '\uFEFF' + fixture.replaceAll('\n', '\r\n');
  const expected = '\uFEFF' + fixture.replace('- 2026-10-01: p. 10\n', '- 2026-10-01: p. 10\n' + progressLine + '\n').replaceAll('\n', '\r\n');
  expect(kernel.appendProgress(crlf, { date: '2026-10-05', page: 40 })).toMatchObject({ text: expected });
});

it('accepts only a page past the current one and at most totalPages', () => {
  for (const page of [10, 5, -1, 101, 1000]) {
    expect(kernel.appendProgress(fixture, { date: '2026-10-05', page })).toMatchObject({ code: 'refused:book-page-invalid' });
  }
  expect(kernel.appendProgress(fixture, { date: '2026-10-05', page: 100 })).toMatchObject({ ok: true });
});

it('appends dated reflections verbatim and keeps same-day entries separate', () => {
  const first = kernel.appendReflection(fixture, { date: '2026-10-05', text: 'Line one\n  Line two  ' });
  if (!first.ok) throw new Error(first.code);
  expect(first.text).toBe(fixture.replace('First reflection\n', 'First reflection\n\n### 2026-10-05\nLine one\n  Line two  \n'));
  const second = kernel.appendReflection(first.text, { date: '2026-10-05', text: 'Another' });
  if (!second.ok) throw new Error(second.code);
  const parsed = kernel.parseBookNote(second.text);
  expect(parsed).toMatchObject({ ok: true, reflections: [
    { date: '2026-10-02', text: 'First reflection' },
    { date: '2026-10-05', text: 'Line one\n  Line two  ' },
    { date: '2026-10-05', text: 'Another' },
  ] });
});

it('refuses empty reflections and a malformed note shape', () => {
  for (const text of ['', '   ', '\n', '\r\n\r\n']) {
    expect(kernel.appendReflection(fixture, { date: '2026-10-05', text })).toMatchObject({ code: 'refused:book-reflection-empty' });
  }
  const noProgress = fixture.replace('## Progress\n', '## Notes\n');
  expect(kernel.appendProgress(noProgress, { date: '2026-10-05', page: 40 })).toMatchObject({ code: 'refused:book-note-shape' });
  expect(kernel.appendReflection(fixture + '\n## Reflections\n### 2026-10-06\nx\n', { date: '2026-10-05', text: 'x' })).toMatchObject({ code: 'refused:book-note-shape' });
  expect(kernel.parseBookNote('# no frontmatter\n## Progress\n## Reflections\n')).toMatchObject({ code: 'refused:book-note-shape' });
});

it('undo is the exact inverse and refuses when the file changed since', () => {
  const after = kernel.appendProgress(fixture, { date: '2026-10-05', page: 40 });
  if (!after.ok) throw new Error(after.code);
  expect(kernel.undoBookEdit(after.text, after.text, fixture, after.effect)).toMatchObject({ ok: true, text: fixture, effect: { kind: 'book', op: 'undone' } });
  expect(kernel.undoBookEdit(after.text + '\n', after.text, fixture, after.effect)).toMatchObject({ code: 'refused:undo-expired' });
});
