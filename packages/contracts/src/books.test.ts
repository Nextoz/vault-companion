import { expect, it } from 'vitest';
import { BooksResponse, Command, bookNotePath, canonicalBookTitle, READING_QUEUE_PATH } from './index.ts';

const envelope = (type: string, payload: unknown) => ({ schemaVersion: 1, operationId: '00000000-0000-4000-8000-000000000001', type, payload, occurredAt: '2026-10-05T10:00:00Z', baseRevision: '1'.repeat(40) });

it('accepts the three book commands and their Undos', () => {
  const start = Command.parse(envelope('StartBook', { title: 'Synthetic Book', author: 'A', totalPages: 100 }));
  expect(Command.safeParse({ ...envelope('UndoStartBook', { target: start, targetCommit: '2'.repeat(40) }) }).success).toBe(true);
  const log = Command.parse(envelope('LogReading', { title: 'Synthetic Book', page: 40, date: '2026-10-05' }));
  expect(Command.safeParse({ ...envelope('UndoLogReading', { target: log, targetCommit: '2'.repeat(40) }) }).success).toBe(true);
  const save = Command.parse(envelope('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: 'anything' }));
  expect(Command.safeParse({ ...envelope('UndoSaveReflection', { target: save, targetCommit: '2'.repeat(40) }) }).success).toBe(true);
});

it('accepts an empty reflection and a non-positive page on the wire so the domain can refuse them typed', () => {
  expect(Command.safeParse(envelope('SaveReflection', { title: 'T', date: '2026-10-05', text: '' })).success).toBe(true);
  expect(Command.safeParse(envelope('LogReading', { title: 'T', page: -1, date: '2026-10-05' })).success).toBe(true);
});

it.each([
  { totalPages: 0 }, { totalPages: 1.5 }, { author: 'a\nb' }, { extra: true }, { title: 5 },
])('rejects invalid StartBook payload %#', (changes) => {
  expect(Command.safeParse(envelope('StartBook', { title: 'T', author: 'A', totalPages: 10, ...changes })).success).toBe(false);
});

it('canonicalises titles into Books/<Title>.md and rejects unusable ones', () => {
  expect(canonicalBookTitle('  Synthetic Book  ')).toBe('Synthetic Book');
  expect(bookNotePath('Synthetic Book')).toBe('Books/Synthetic Book.md');
  for (const title of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '.hidden', 'x'.repeat(81)]) {
    expect(canonicalBookTitle(title)).toBeNull();
    expect(bookNotePath(title)).toBeNull();
  }
  // The queue note is a valid path shape and is excluded by the write guard, not by the title rule.
  expect(canonicalBookTitle('Reading Queue')).toBe('Reading Queue');
  expect(bookNotePath('Reading Queue')).toBe(READING_QUEUE_PATH);
});

it('parses a books response', () => {
  const r = BooksResponse.parse({
    status: 'ok',
    revision: '1'.repeat(40),
    books: [{ title: 'Synthetic Book', author: 'A', totalPages: 100, currentPage: 40, status: 'reading', lastRead: '2026-10-05', reflections: [{ date: '2026-10-05', text: 'note' }] }],
  });
  expect(r.status).toBe('ok');
  expect(BooksResponse.safeParse({ status: 'ok', revision: '1'.repeat(40), books: [{ title: 'T' }] }).success).toBe(false);
});
