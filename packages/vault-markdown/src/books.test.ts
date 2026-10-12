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
  const pageless = kernel.createBookNote({ title: 'Audio', author: '' });
  expect(pageless).not.toContain('totalPages');
  expect(kernel.parseBookNote(pageless)).toMatchObject({ ok: true, frontmatter: { totalPages: null, status: 'reading' } });
  expect(kernel.appendProgress(pageless, { date: '2026-10-05', page: 1 })).toMatchObject({ code: 'refused:book-page-invalid' });
  expect(kernel.appendReflection(pageless, { date: '2026-10-05', text: 'a thought' })).toMatchObject({ ok: true });
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

it('refuses reflection text that contains heading lines', () => {
  for (const text of ['## Reflections', 'fine'+String.fromCharCode(10)+'### 2026-10-06', '# Title']) {
    expect(kernel.appendReflection(fixture, { date: '2026-10-05', text })).toMatchObject({ ok: false, code: 'invalid' });
  }
  expect(kernel.appendReflection(fixture, { date: '2026-10-05', text: 'a #hashtag and C# are fine' })).toMatchObject({ ok: true });
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

const followUp = { date: '2026-10-02', ordinal: 1, question: 'What changed?', answer: 'A synthetic answer\n  With spacing  ' };
const twoEntries = fixture + '\n### 2026-10-02\nSecond reflection\n\n## Appendix\nUntouched tail\n';

it.each(['lf', 'crlf-bom', 'no-final-newline'])('golden follow-up splice targets ordinal 1 of two same-day entries (%s)', (format) => {
  const convert = (text: string) => format === 'crlf-bom' ? '\uFEFF' + text.replaceAll('\n', '\r\n') : format === 'no-final-newline' ? text.slice(0, -1) : text;
  const source = convert(twoEntries);
  const expected = convert(twoEntries.replace('First reflection\n', 'First reflection\n\n> AI question: What changed?\n\nA synthetic answer\n  With spacing  \n'));
  const result = kernel.appendFollowUp(source, followUp);
  if (!result.ok) throw new Error(result.code);
  expect(result.text).toBe(expected);
  expect(kernel.undoBookEdit(result.text, result.text, source, result.effect)).toMatchObject({ ok: true, text: source });
  expect(kernel.undoBookEdit(result.text + 'x', result.text, source, result.effect)).toMatchObject({ code: 'refused:undo-expired' });
});

it('selects ordinal 2 only among entries of the requested date, including at EOF', () => {
  const source = fixture + '\n### 2026-10-03\nDifferent date\n\n### 2026-10-02\nSecond reflection';
  const result = kernel.appendFollowUp(source, { ...followUp, ordinal: 2, answer: 'Answer' });
  expect(result).toMatchObject({ ok: true, text: source + '\n\n> AI question: What changed?\n\nAnswer' });
});

it('refuses empty, multiline or hash-containing questions, empty answers and heading lines in answers', () => {
  for (const question of ['', ' \t ', 'Why?\nHow?', 'Why?\rHow?', 'Why?\u2028How?', 'Why?\u2029How?', '# Why?', '## Why?', 'How about C#?']) {
    expect(kernel.appendFollowUp(twoEntries, { ...followUp, question })).toMatchObject({ ok: false, code: 'invalid' });
  }
  for (const answer of ['', ' \t ', '\r\n']) {
    expect(kernel.appendFollowUp(twoEntries, { ...followUp, answer })).toMatchObject({ ok: false, code: 'refused:book-reflection-empty' });
  }
  for (const answer of ['# Title', 'fine\n## Reflections', 'fine\r\n  ### 2026-10-03']) {
    expect(kernel.appendFollowUp(twoEntries, { ...followUp, answer })).toMatchObject({ ok: false, code: 'invalid' });
  }
});

it('missing reflection is typed and fake dated headings in code/quotes are not selectable', () => {
  for (const selection of [{ date: '2026-10-03' }, { ordinal: 3 }]) {
    expect(kernel.appendFollowUp(twoEntries, { ...followUp, ...selection })).toMatchObject({ code: 'reflection-not-found' });
  }
  const source = fixture + '\n```\n### 2026-10-03\nCode\n```\n> ### 2026-10-03\n';
  expect(kernel.appendFollowUp(source, { ...followUp, date: '2026-10-03' })).toMatchObject({ code: 'reflection-not-found' });
});
