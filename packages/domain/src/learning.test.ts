/// <reference types="node" />
import { Command, LearningResponse, LEARNING_PATH, MAX_NOTE_BYTES, type Receipt } from '@vault-companion/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandService } from './commands.ts';
import { createLearningService } from './learning.ts';
import * as paths from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

vi.mock('./paths.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof paths>();
  return { ...actual, canWrite: vi.fn(actual.canWrite) };
});
afterEach(() => vi.mocked(paths.canWrite).mockReset());

const fixture = '\uFEFF---\r\nprivate: synthetic\r\n---\r\n## Kinds\r\n| id | Name | Score means | Status |\r\n| --- | --- | --- | --- |\r\n| dictation | Dictation | accuracy | active |\r\n\r\n## Log\r\n| Date | Kind | Min | Score | Detail | Topic or source | Note |\r\n| --- | --- | --- | --- | --- | --- | --- |\r\n| 2026-09-30 | verbs | 10 | 5 | | school | |\r\n| bad-date | odd |\r\n\r\n## Notes\r\nNever display this\r\n';
const NOW = new Date('2026-10-04T08:00:00Z');
const session = { kind: 'dictation', date: '2026-10-04', minutes: 15, score: 7, detail: 'acc 8', topic: 'weather report' };
const line = '| 2026-10-04 | dictation | 15 | 7 | acc 8 | weather report | |';
let n = 0;
function receipt(r: Receipt | { code: string }): Receipt { if ('code' in r) throw new Error(r.code); return r; }

async function setup(text: string | null = fixture) {
  const store = await InMemoryStore.create(text === null ? {} : { [LEARNING_PATH]: text });
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const reader = createLearningService({ store });
  const command = (type: string, payload: unknown) => Command.parse({ schemaVersion: 1, operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, type, payload, baseRevision: store.headCommit, occurredAt: NOW.toISOString() });
  const run = (cmd: Command) => service.execute(cmd, cmd);
  return { store, command, run, read: reader.readLearning };
}

it('allowlist permits only an update to the exact Learning Gym Log path', () => {
  const target = paths.parseVaultPath(LEARNING_PATH)!;
  expect(paths.canWrite(target, 'update')).toBe(true);
  expect(paths.canWrite(target, 'create')).toBe(false);
  for (const path of ['Personal/Other.md', 'Personal/learning gym log.md', 'Personal/Sub/Learning Gym Log.md']) {
    expect(paths.canWrite(paths.parseVaultPath(path)!, 'update')).toBe(false);
    expect(paths.canWrite(paths.parseVaultPath(path)!, 'create')).toBe(false);
  }
});

it.each(['LogLearning', 'UndoLogLearning'])('denied canWrite refuses %s without writing', async (type) => {
  const h = await setup();
  const target = h.command('LogLearning', { session });
  const saved = type === 'UndoLogLearning' ? receipt(await h.run(target)) : null;
  const cmd = saved ? h.command(type, { target, targetCommit: saved.commitSha }) : target;
  const head = h.store.headCommit;
  const writes = h.store.writeCalls;
  vi.mocked(paths.canWrite).mockReturnValue(false);
  expect(await h.run(cmd)).toMatchObject({ code: 'refused:path' });
  expect(h.store.writeCalls).toBe(writes);
  expect(h.store.headCommit).toBe(head);
  expect(paths.canWrite).toHaveBeenCalledWith(LEARNING_PATH, 'update');
});

it('read exposes kinds, newest rows and unknown Log lines only', async () => {
  const h = await setup();
  receipt(await h.run(h.command('LogLearning', { session })));
  const r = LearningResponse.parse(await h.read());
  expect(r).toMatchObject({
    status: 'ok',
    kinds: [{ id: 'dictation', name: 'Dictation', scoreMeans: 'accuracy', status: 'active' }],
    rows: [{ date: '2026-10-04', kind: 'dictation' }, { date: '2026-09-30', kind: 'verbs' }],
    unknownLines: ['| bad-date | odd |'],
  });
  expect(JSON.stringify(r)).not.toContain('Never display');
  expect(JSON.stringify(r)).not.toContain('private');
});

it('missing file is absent and never created; unknown kind and missing table refuse writes', async () => {
  const h = await setup(null);
  expect(await h.read()).toMatchObject({ status: 'absent' });
  expect(await h.run(h.command('LogLearning', { session }))).toMatchObject({ code: 'refused:structure' });
  expect(h.store.writeCalls).toBe(0);

  const unknown = await setup();
  expect(await unknown.run(unknown.command('LogLearning', { session: { ...session, kind: 'nope' } }))).toMatchObject({ code: 'refused:learning-kind-unknown' });
  expect(unknown.store.writeCalls).toBe(0);

  const wrong = await setup(fixture.replace('| Min |', '| Mins |'));
  expect(await wrong.run(wrong.command('LogLearning', { session }))).toMatchObject({ code: 'refused:learning-table-missing' });
  expect(wrong.store.writeCalls).toBe(0);
});

it('lost replies and retries yield one row, one commit and verified trailers', async () => {
  const h = await setup();
  const target = h.command('LogLearning', { session });
  h.store.writeFaults.push('apply-then-unknown');
  const first = receipt(await h.run(target));
  expect(first.status).toBe('already-applied');
  expect(await h.run(target)).toEqual(first);
  expect(h.store.writeCalls).toBe(1);
  expect(h.store.text(LEARNING_PATH)).toBe(fixture.replace('\r\n\r\n## Notes', '\r\n' + line + '\r\n\r\n## Notes'));
  expect((await h.store.readCommit(first.commitSha))?.trailers).toMatchObject({ [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) });
});

it('Undo removes exactly the inserted row and refuses when the file changed since', async () => {
  const h = await setup();
  const target = h.command('LogLearning', { session });
  const logged = receipt(await h.run(target));
  const undo = h.command('UndoLogLearning', { target, targetCommit: logged.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone.effect).toMatchObject({ kind: 'learning', op: 'undone' });
  expect(h.store.text(LEARNING_PATH)).toBe(fixture);
  expect(await h.run(undo)).toEqual({ ...undone, status: 'already-applied' });
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);

  const changed = await setup();
  const changedTarget = changed.command('LogLearning', { session });
  const changedLogged = receipt(await changed.run(changedTarget));
  await changed.store.commitFiles({ [LEARNING_PATH]: changed.store.text(LEARNING_PATH)! + ' ' });
  expect(await changed.run(changed.command('UndoLogLearning', { target: changedTarget, targetCommit: changedLogged.commitSha }))).toMatchObject({ code: 'refused:undo-expired' });
});

it('read refuses invalid UTF-8, oversized files and truncated listings', async () => {
  const h = await setup();
  await h.store.commitFiles({ [LEARNING_PATH]: new Uint8Array([0xff]) });
  expect(await h.read()).toMatchObject({ code: 'refused:encoding' });
  await h.store.commitFiles({ [LEARNING_PATH]: fixture.padEnd(MAX_NOTE_BYTES + 1, ' ') });
  expect(await h.read()).toMatchObject({ code: 'refused:too-large' });
});
