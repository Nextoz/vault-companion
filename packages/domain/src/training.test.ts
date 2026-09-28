/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as contracts from '@vault-companion/contracts';
import { Command, TrainingResponse, TRAINING_PATH, type Receipt } from '@vault-companion/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { createTrainingService } from './training.ts';
import { createCommandService } from './commands.ts';
import * as paths from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';
vi.mock('./paths.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof paths>();
  return { ...actual, canWrite: vi.fn(actual.canWrite) };
});
afterEach(() => vi.mocked(paths.canWrite).mockReset());
const fixture = '\uFEFF---\r\nprivate: synthetic\r\n---\r\n## Sessions\r\n| Date | Time | Type | Distance | Duration | Weight | Split | Note |\r\n| --- | --- | --- | --- | --- | --- | --- | --- |\r\n| 2026-09-27 | | Group workout | | | | | |\r\n| unknown | bytes |\r\n\r\n## Week summaries\r\nNever display this\r\n';
const NOW = new Date('2026-09-28T16:42:00Z');
const session = { type: 'Run', when: NOW.toISOString(), distance: 5.2, duration: 28, note: 'Easy loop' };
const line = '| 2026-09-28 | 18:42 | Run | 5.2 km | 28 min | | | Easy loop |';
let n = 0;
function receipt(r: Receipt | { code: string }): Receipt { if ('code' in r) throw new Error(r.code); return r; }
async function setup(text: string | null = fixture) {
  const store = await InMemoryStore.create(text === null ? {} : { [TRAINING_PATH]: text });
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const reader = createTrainingService({ store });
  const command = (type: string, payload: unknown) => Command.parse({ schemaVersion: 1, operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, type, payload, baseRevision: store.headCommit, occurredAt: NOW.toISOString() });
  const run = (cmd: Command) => service.execute(cmd, cmd);
  return { store, command, run, read: reader.readTraining };
}
it.each(['LogTraining', 'UndoLogTraining'])('denied canWrite refuses %s without writing', async (type) => {
  const h = await setup();
  const target = h.command('LogTraining', { session });
  const saved = type === 'UndoLogTraining' ? receipt(await h.run(target)) : null;
  const cmd = saved ? h.command(type, { target, targetCommit: saved.commitSha }) : target;
  const head = h.store.headCommit;
  const writes = h.store.writeCalls;
  vi.mocked(paths.canWrite).mockReturnValue(false);
  const result = await h.run(cmd);
  expect(h.store.writeCalls).toBe(writes);
  expect(h.store.headCommit).toBe(head);
  expect(result).toMatchObject({ code: 'refused:path' });
  expect(paths.canWrite).toHaveBeenCalledWith(TRAINING_PATH, 'update');
});
it('read exposes newest sessions and unknown lines only', async () => {
  const h = await setup();
  receipt(await h.run(h.command('LogTraining', { session })));
  const r = TrainingResponse.parse(await h.read());
  expect(r).toMatchObject({ status: 'ok', rows: [{ date: '2026-09-28', time: '18:42' }, { type: 'Group workout', time: '' }], unknownLines: ['| unknown | bytes |'] });
  expect(JSON.stringify(r)).not.toContain('Never display');
  expect(JSON.stringify(r)).not.toContain('private');
});
it('read sorts an unsorted legacy table and is pinned to one revision', async () => {
  const h = await setup(fixture.replace('| unknown', line + '\r\n| unknown'));
  const pinned = h.store.headCommit;
  h.store.afterHead = async () => { h.store.afterHead = null; await h.store.commitFiles({ [TRAINING_PATH]: 'changed' }); };
  expect(await h.read()).toMatchObject({ status: 'ok', revision: pinned, rows: [{ date: '2026-09-28' }, { date: '2026-09-27' }] });
});
it('never reads an unlisted file or returns mismatched bytes (including followed symlinks)', async () => {
  const h = await setup(); const realRead = h.store.readFile.bind(h.store);
  h.store.readFile = async (path, at) => { const file = await realRead(path, at); return file && { ...file, blobSha: 'f'.repeat(40) }; };
  expect(await h.read()).toMatchObject({ status: 'absent' });
  h.store.listFiles = async () => [];
  h.store.readFile = async () => { throw new Error('must not read unlisted file'); };
  expect(await h.read()).toMatchObject({ status: 'absent' });
});
it('read refuses invalid UTF-8, oversized files and truncated regular-file listings', async () => {
  const h = await setup();
  await h.store.commitFiles({ [TRAINING_PATH]: new Uint8Array([0xff]) });
  expect(await h.read()).toMatchObject({ code: 'refused:encoding' });
  await h.store.commitFiles({ [TRAINING_PATH]: fixture.padEnd(contracts.MAX_NOTE_BYTES + 1, ' ') });
  expect(await h.read()).toMatchObject({ code: 'refused:too-large' });
  await h.store.commitFiles({ [TRAINING_PATH]: fixture }); h.store.listFilesLimit = 0;
  expect(await h.read()).toMatchObject({ code: 'refused:too-large' });
});
it('lost replies and retries yield one row, one commit, verified trailers', async () => {
  const h = await setup(); const target = h.command('LogTraining', { session });
  h.store.writeFaults.push('apply-then-unknown');
  const first = receipt(await h.run(target));
  expect(first.status).toBe('already-applied'); expect(await h.run(target)).toEqual(first);
  expect(h.store.writeCalls).toBe(1);
  expect(h.store.text(TRAINING_PATH)).toBe(fixture.replace('| 2026-09-27', line + '\r\n| 2026-09-27'));
  expect((await h.store.readCommit(first.commitSha))?.trailers).toMatchObject({ [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) });
});
it('stale base and head-CAS replay preserve a concurrent edit', async () => {
  const h = await setup(); const cmd = h.command('LogTraining', { session });
  await h.store.commitFiles({ [TRAINING_PATH]: fixture.replace('Never display', 'Updated summary') });
  h.store.afterHead = async () => { h.store.afterHead = null; await h.store.commitFiles({ [TRAINING_PATH]: h.store.text(TRAINING_PATH)! + 'Desktop tail\r\n' }); };
  receipt(await h.run(cmd));
  expect(h.store.text(TRAINING_PATH)).toBe(fixture.replace('Never display', 'Updated summary').replace('| 2026-09-27', line + '\r\n| 2026-09-27') + 'Desktop tail\r\n');
});
it('Undo restores original bytes, dedupes, and cannot undo twice', async () => {
  const h = await setup(); const target = h.command('LogTraining', { session }); const logged = receipt(await h.run(target));
  await h.store.commitFiles({ 'Inbox/Other.md': 'unrelated' });
  const undo = h.command('UndoLogTraining', { target, targetCommit: logged.commitSha });
  h.store.writeFaults.push('apply-then-unknown'); const undone = receipt(await h.run(undo));
  expect(undone.effect).toMatchObject({ kind: 'training', op: 'undone' });
  expect(h.store.text(TRAINING_PATH)).toBe(fixture); expect(await h.run(undo)).toEqual(undone);
  expect(h.store.writeCalls).toBe(2);
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);
  expect(await h.run(h.command('UndoLogTraining', { target, targetCommit: logged.commitSha }))).toMatchObject({ code: 'conflict:task-changed' });
});
it('Undo refuses intervening edits, forged token, altered target, unknown and unbounded history', async () => {
  const h = await setup(); const target = h.command('LogTraining', { session }); const logged = receipt(await h.run(target));
  const undo = (targetCommit = logged.commitSha, t = target) => h.command('UndoLogTraining', { target: t, targetCommit });
  await h.store.commitFiles({ [TRAINING_PATH]: h.store.text(TRAINING_PATH)! + ' ' });
  expect(await h.run(undo())).toMatchObject({ code: 'refused:undo-expired' });
  expect(await h.run(undo(h.store.headCommit))).toMatchObject({ code: 'invalid' });
  expect(await h.run(undo('f'.repeat(40)))).toMatchObject({ code: 'conflict:task-changed' });
  expect(await h.run(undo(logged.commitSha, { ...target, occurredAt: '2026-09-28T16:43:00Z' }))).toMatchObject({ code: 'invalid' });
  h.store.comparePageSize = 0;
  expect(await h.run(undo())).toMatchObject({ code: 'dedupe-unknown' });
  expect(h.store.writeCalls).toBe(1);
});
it('forged log bytes cannot be certified by retry or Undo', async () => {
  const h = await setup(); const target = h.command('LogTraining', { session });
  const forged = await h.store.writeFile({ path: TRAINING_PATH as VaultPath, baseCommit: h.store.headCommit, expect: 'regular-file', bytes: new TextEncoder().encode(fixture + 'forged'), message: 'synthetic forged session', trailers: { [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) } });
  if (!forged.ok) throw new Error('fixture');
  expect(await h.run(target)).toMatchObject({ code: 'dedupe-unknown' });
  expect(await h.run(h.command('UndoLogTraining', { target, targetCommit: forged.commitSha }))).toMatchObject({ code: 'dedupe-unknown' });
});
it('a forged Undo commit cannot produce a receipt without verified inverse bytes and trailers', async () => {
  for (const withTrailer of [true, false]) {
    const h = await setup(); const target = h.command('LogTraining', { session }); const saved = receipt(await h.run(target));
    const undo = h.command('UndoLogTraining', { target, targetCommit: saved.commitSha });
    await h.store.commitFiles({ [TRAINING_PATH]: fixture + 'forged' }, 'synthetic forged undo', {
      [TRAILER_OP]: undo.operationId, [TRAILER_PAYLOAD]: await payloadHash(undo), ...(withTrailer ? { [TRAILER_UNDOES]: target.operationId } : {}),
    });
    expect(await h.run(undo)).toMatchObject({ code: 'dedupe-unknown' });
  }
});
it('missing file is absent and never created; wrong table refuses writes', async () => {
  const h = await setup(null); expect(await h.read()).toMatchObject({ status: 'absent' });
  expect(await h.run(h.command('LogTraining', { session }))).toMatchObject({ code: 'refused:structure' });
  expect(h.store.writeCalls).toBe(0);
  const wrong = await setup(fixture.replace('Distance', 'distance'));
  expect(await wrong.read()).toMatchObject({ status: 'refused', code: 'refused:training-table-missing' });
  expect(await wrong.run(wrong.command('LogTraining', { session }))).toMatchObject({ code: 'refused:training-table-missing' });
  expect(wrong.store.writeCalls).toBe(0);
});
it('allowlist permits only an update to the exact path, and kills broadened/removed guards', () => {
  const assertion = (canWrite: typeof paths.canWrite) => {
    expect(canWrite(paths.parseVaultPath(TRAINING_PATH)!, 'update')).toBe(true);
    expect(canWrite(paths.parseVaultPath(TRAINING_PATH)!, 'create')).toBe(false);
    for (const path of ['Health/Other.md', 'Health/training log.md', 'Health/Sub/Training Log.md']) {
      expect(canWrite(paths.parseVaultPath(path)!, 'update')).toBe(false);
      expect(canWrite(paths.parseVaultPath(path)!, 'create')).toBe(false);
    }
  };
  assertion(paths.canWrite);
  const source = readFileSync(new URL('./paths.ts', import.meta.url), 'utf8');
  for (const replacement of ["path.startsWith('Health/')", 'false']) {
    expect(source).toContain('path === TRAINING_PATH');
    const js = ts.transpileModule(source.replace('path === TRAINING_PATH', replacement), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {} as typeof paths; runInNewContext(js, { exports, require: () => contracts });
    expect(() => assertion(exports.canWrite)).toThrow();
  }
});
