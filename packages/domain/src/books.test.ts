/// <reference types="node" />
import { BooksResponse, Command, READING_QUEUE_PATH, type Receipt } from '@vault-companion/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createBooksService } from './books.ts';
import { createCommandService } from './commands.ts';
import * as paths from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

vi.mock('./paths.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof paths>();
  return { ...actual, canWrite: vi.fn(actual.canWrite) };
});
afterEach(() => vi.mocked(paths.canWrite).mockReset());

const BOOK = 'Books/Synthetic Book.md';
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
const NOW = new Date('2026-10-05T08:00:00Z');
let n = 0;
function receipt(r: Receipt | { code: string }): Receipt { if ('code' in r) throw new Error(r.code); return r; }

async function setup(files: Record<string, string> = {}) {
  const store = await InMemoryStore.create(files);
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const reader = createBooksService({ store });
  const command = (type: string, payload: unknown) => Command.parse({ schemaVersion: 1, operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, type, payload, baseRevision: store.headCommit, occurredAt: NOW.toISOString() });
  const run = (cmd: Command) => service.execute(cmd, cmd);
  return { store, command, run, read: reader.readBooks };
}

it('allowlists create and update only for Books/<Title>.md', () => {
  for (const kind of ['create', 'update'] as const) {
    expect(paths.canWrite(paths.parseVaultPath(BOOK)!, kind)).toBe(true);
    for (const path of [READING_QUEUE_PATH, 'Books/reading queue.md', 'Books/READING QUEUE.md', 'Books/nested/Book.md', 'Books/.hidden.md', 'Books/a|b.md', 'Other/Book.md']) {
      const parsed = paths.parseVaultPath(path);
      if (parsed) expect(paths.canWrite(parsed, kind)).toBe(false);
    }
  }
});

it('never writes Books/Reading Queue.md — the path guard refuses it', async () => {
  const h = await setup({ [READING_QUEUE_PATH]: 'queue\n' });
  const head = h.store.headCommit;
  const writes = h.store.writeCalls;
  expect(await h.run(h.command('SaveReflection', { title: 'Reading Queue', date: '2026-10-05', text: 'x' }))).toMatchObject({ code: 'refused:path' });
  expect(await h.run(h.command('StartBook', { title: 'reading queue', author: '', totalPages: 10 }))).toMatchObject({ code: 'refused:path' });
  expect(paths.canWrite(paths.parseVaultPath(READING_QUEUE_PATH)!, 'update')).toBe(false);
  expect(h.store.writeCalls).toBe(writes);
  expect(h.store.headCommit).toBe(head);
  expect(h.store.text(READING_QUEUE_PATH)).toBe('queue\n');
});

it('denied canWrite refuses every book command without writing', async () => {
  const h = await setup({ [BOOK]: fixture });
  const target = h.command('StartBook', { title: 'Another Book', author: '', totalPages: 10 });
  const log = h.command('LogReading', { title: 'Synthetic Book', page: 40, date: '2026-10-05' });
  vi.mocked(paths.canWrite).mockReturnValue(false);
  const head = h.store.headCommit;
  expect(await h.run(target)).toMatchObject({ code: 'refused:path' });
  expect(await h.run(log)).toMatchObject({ code: 'refused:path' });
  expect(h.store.writeCalls).toBe(0);
  expect(h.store.headCommit).toBe(head);
});

it('StartBook creates a valid note, refuses the same title again and every invalid title', async () => {
  const h = await setup();
  const started = receipt(await h.run(h.command('StartBook', { title: 'Synthetic Book', author: 'Synthetic Author', totalPages: 100 })));
  expect(started.path).toBe(BOOK);
  expect(started.effect).toMatchObject({ kind: 'book', op: 'started', path: BOOK });
  const text = h.store.text(BOOK)!;
  for (const line of ['type: book', 'status: reading', 'author: Synthetic Author', 'totalPages: 100', '# Synthetic Book', '## Progress', '## Reflections']) expect(text).toContain(line);

  expect(await h.run(h.command('StartBook', { title: 'Synthetic Book', author: 'A', totalPages: 10 }))).toMatchObject({ code: 'refused:book-exists' });
  expect(await h.run(h.command('StartBook', { title: 'synthetic book', author: 'A', totalPages: 10 }))).toMatchObject({ code: 'refused:book-exists' });
  for (const title of ['', '   ', 'a/b', 'a:b', '.hidden', 'x'.repeat(81)]) {
    expect(await h.run(h.command('StartBook', { title, author: '', totalPages: 10 }))).toMatchObject({ code: 'refused:book-title-invalid' });
  }
});

it('LogReading appends one line and refuses a page at or before the current page or past totalPages', async () => {
  const h = await setup({ [BOOK]: fixture });
  const logged = receipt(await h.run(h.command('LogReading', { title: 'Synthetic Book', page: 40, date: '2026-10-05' })));
  expect(logged.effect).toMatchObject({ kind: 'book', op: 'logged', path: BOOK });
  expect(h.store.text(BOOK)).toBe(fixture.replace('- 2026-10-01: p. 10\n', '- 2026-10-01: p. 10\n- 2026-10-05: p. 40\n'));
  for (const page of [40, 10, 5, 101]) {
    expect(await h.run(h.command('LogReading', { title: 'Synthetic Book', page, date: '2026-10-06' }))).toMatchObject({ code: 'refused:book-page-invalid' });
  }
});

it('SaveReflection keeps same-day entries separate, stores text verbatim and refuses an empty one', async () => {
  const h = await setup({ [BOOK]: fixture });
  expect(await h.run(h.command('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: '   ' }))).toMatchObject({ code: 'refused:book-reflection-empty' });
  receipt(await h.run(h.command('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: 'Line one\nLine two' })));
  const second = receipt(await h.run(h.command('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: 'Another' })));
  expect(second.effect).toMatchObject({ kind: 'book', op: 'reflected', path: BOOK });
  const text = h.store.text(BOOK)!;
  expect(text).toContain('First reflection\n\n### 2026-10-05\nLine one\nLine two\n\n### 2026-10-05\nAnother\n');
  expect(text.match(/### 2026-10-05/g)).toHaveLength(2);
});

it('missing or duplicate Progress/Reflections headings refuse as book-note-shape', async () => {
  const h = await setup({ [BOOK]: fixture.replace('## Progress\n', '## Notes\n') });
  expect(await h.run(h.command('LogReading', { title: 'Synthetic Book', page: 40, date: '2026-10-05' }))).toMatchObject({ code: 'refused:book-note-shape' });
  const dup = await setup({ [BOOK]: fixture + '\n## Reflections\n' });
  expect(await dup.run(dup.command('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: 'x' }))).toMatchObject({ code: 'refused:book-note-shape' });
});

it('Undo of LogReading and SaveReflection restores the parent bytes and refuses once the file changed', async () => {
  const h = await setup({ [BOOK]: fixture });
  const log = h.command('LogReading', { title: 'Synthetic Book', page: 40, date: '2026-10-05' });
  const logged = receipt(await h.run(log));
  const undo = h.command('UndoLogReading', { target: log, targetCommit: logged.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone.effect).toMatchObject({ kind: 'book', op: 'undone', path: BOOK });
  expect(h.store.text(BOOK)).toBe(fixture);
  expect(await h.run(undo)).toEqual({ ...undone, status: 'already-applied' });
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(log.operationId);

  const changed = await setup({ [BOOK]: fixture });
  const target = changed.command('SaveReflection', { title: 'Synthetic Book', date: '2026-10-05', text: 'x' });
  const saved = receipt(await changed.run(target));
  await changed.store.commitFiles({ [BOOK]: changed.store.text(BOOK)! + 'extra\n' });
  expect(await changed.run(changed.command('UndoSaveReflection', { target, targetCommit: saved.commitSha }))).toMatchObject({ code: 'refused:undo-expired' });
});

it('Undo of StartBook deletes only the created note, is idempotent and refuses a double undo', async () => {
  const h = await setup();
  const target = h.command('StartBook', { title: 'Synthetic Book', author: 'A', totalPages: 100 });
  const started = receipt(await h.run(target));
  const undo = h.command('UndoStartBook', { target, targetCommit: started.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone.effect).toMatchObject({ kind: 'book', op: 'undone', path: BOOK });
  expect(h.store.text(BOOK)).toBeNull();
  expect(await h.run(undo)).toEqual({ ...undone, status: 'already-applied' });
  expect(await h.store.readCommit(undone.commitSha)).toMatchObject({ files: [{ path: BOOK, blobSha: null }] });
});

it('dedupes a lost reply, verifies trailers and refuses a stale base instead of guessing', async () => {
  const h = await setup();
  const target = h.command('StartBook', { title: 'Synthetic Book', author: 'A', totalPages: 100 });
  h.store.writeFaults.push('apply-then-unknown');
  const first = receipt(await h.run(target));
  expect(first.status).toBe('already-applied');
  expect(await h.run(target)).toEqual(first);
  expect(h.store.writeCalls).toBe(1);
  expect((await h.store.readCommit(first.commitSha))?.trailers).toMatchObject({ [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) });

  const stale = Command.parse({ ...target, operationId: '00000000-0000-4000-8000-00000000dead', baseRevision: 'a'.repeat(40) });
  expect(await h.run(stale)).toMatchObject({ code: 'dedupe-unknown' });
});

it('a head that keeps moving ends in an explicit conflict, never a merge', async () => {
  const h = await setup();
  let moves = 0;
  h.store.afterHead = async () => { await h.store.commitFiles({ 'Inbox/move.md': `move ${++moves}\n` }); };
  expect(await h.run(h.command('StartBook', { title: 'Synthetic Book', author: 'A', totalPages: 100 }))).toMatchObject({ code: 'conflict:stale', retryable: true });
  expect(h.store.text(BOOK)).toBeNull();
});

it('listBooks projects every book, skips the queue and unmanaged notes, and keeps reflection text', async () => {
  const h = await setup({ [BOOK]: fixture, [READING_QUEUE_PATH]: 'queue\n', 'Books/Notes.md': 'no frontmatter\n' });
  const r = BooksResponse.parse(await h.read());
  expect(r).toEqual({
    status: 'ok',
    revision: h.store.headCommit,
    books: [{
      title: 'Synthetic Book',
      author: 'Synthetic Author',
      totalPages: 100,
      currentPage: 10,
      status: 'reading',
      lastRead: '2026-10-01',
      reflections: [{ date: '2026-10-02', text: 'First reflection' }],
    }],
  });
});

const followUpPayload = { title: 'Synthetic Book', date: '2026-10-02', ordinal: 1, question: 'What changed?', answer: 'Synthetic answer' };

it('SaveFollowUp splices ordinal 1, dedupes a lost reply, and exact Undo restores every parent byte', async () => {
  const source = '\uFEFF' + (fixture + '\n### 2026-10-02\nSecond reflection\n').replaceAll('\n', '\r\n');
  const h = await setup({ [BOOK]: source });
  const target = h.command('SaveFollowUp', followUpPayload);
  h.store.writeFaults.push('apply-then-unknown');
  const saved = receipt(await h.run(target));
  expect(saved.status).toBe('already-applied');
  expect(h.store.text(BOOK)).toBe(source.replace('First reflection\r\n', 'First reflection\r\n\r\n> AI question: What changed?\r\n\r\nSynthetic answer\r\n'));
  expect(await h.run(target)).toEqual(saved);
  expect(h.store.writeCalls).toBe(1);
  expect((await h.store.readCommit(saved.commitSha))?.trailers).toMatchObject({ [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) });
  const undo = h.command('UndoSaveFollowUp', { target, targetCommit: saved.commitSha });
  const undone = receipt(await h.run(undo));
  expect(h.store.text(BOOK)).toBe(source);
  expect(await h.run(undo)).toEqual({ ...undone, status: 'already-applied' });
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);
});

it('follow-up Undo refuses changed bytes and a forged target', async () => {
  const h = await setup({ [BOOK]: fixture });
  const target = h.command('SaveFollowUp', followUpPayload);
  const saved = receipt(await h.run(target));
  const forged = Command.parse({ ...target, payload: { ...target.payload, answer: 'Forged answer' } });
  expect(await h.run(h.command('UndoSaveFollowUp', { target: forged, targetCommit: saved.commitSha }))).toMatchObject({ code: 'invalid' });
  await h.store.commitFiles({ [BOOK]: h.store.text(BOOK)! + 'Desktop edit\n' });
  expect(await h.run(h.command('UndoSaveFollowUp', { target, targetCommit: saved.commitSha }))).toMatchObject({ code: 'refused:undo-expired' });
});

it('SaveFollowUp enforces path guards and refuses missing entries or unsafe text without writing', async () => {
  const h = await setup({ [BOOK]: fixture, [READING_QUEUE_PATH]: 'queue\n' });
  for (const [changes, code] of [
    [{ title: 'Reading Queue' }, 'refused:path'], [{ title: 'a/b' }, 'refused:book-title-invalid'],
    [{ ordinal: 2 }, 'reflection-not-found'], [{ date: '2026-10-03' }, 'reflection-not-found'],
    [{ question: '' }, 'invalid'], [{ question: 'Why?\nHow?' }, 'invalid'],
    [{ answer: '' }, 'refused:book-reflection-empty'], [{ answer: '## Reflections' }, 'invalid'],
  ] as const) {
    expect(await h.run(h.command('SaveFollowUp', { ...followUpPayload, ...changes }))).toMatchObject({ code });
  }
  vi.mocked(paths.canWrite).mockReturnValue(false);
  expect(await h.run(h.command('SaveFollowUp', followUpPayload))).toMatchObject({ code: 'refused:path' });
  expect(h.store.writeCalls).toBe(0);
  expect(h.store.text(BOOK)).toBe(fixture);
});
