/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { ActiveWorkResponse, Command, type Receipt } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createActiveWorkService } from './active-work.ts';
import { createCommandService } from './commands.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const PATH = 'Tasks/Active Work Now.md';
const fixture = readFileSync(new URL('../../vault-markdown/src/fixtures/active-work.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const NOW = new Date('2026-09-26T22:30:00Z'); // Copenhagen: 27 September.
let n = 0;
const id = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
function receipt(r: Receipt | { code: string }): Receipt {
  if ('code' in r) throw new Error(r.code);
  return r;
}
async function setup(text = fixture) {
  const store = await InMemoryStore.create({ [PATH]: text });
  const deps = { store, now: () => NOW, timeZone: 'Europe/Copenhagen' };
  const service = createCommandService(deps);
  const reader = createActiveWorkService(deps);
  const read = async () => {
    const r = ActiveWorkResponse.parse(await reader.readActiveWork());
    if (r.status !== 'ok') throw new Error(r.status);
    return r;
  };
  const command = (type: string, payload: unknown) => Command.parse({ schemaVersion: 1, operationId: id(), type, payload, baseRevision: store.headCommit, occurredAt: NOW.toISOString() });
  const run = (cmd: Command) => service.execute(cmd, cmd);
  return { store, read, command, run };
}

describe('Active Work service and write plans', () => {
  it('read model uses Copenhagen date, locators and unknown lines', async () => {
    const h = await setup();
    const r = await h.read();
    expect(r.today).toBe('2026-09-27');
    expect(r.items.map((t) => [t.name, t.needsReview])).toEqual([['Garden plan', false], ['Bike repair', true]]);
    expect(r.unknownNowLines).toEqual(['', '', 'Prose paragraph that follows the items inside Now.', '']);
    expect(r.items[1]!.locator).toMatchObject({ path: PATH, blobSha: r.blobSha, lineIndex: 13, occurrencesAtRead: 1 });
  });

  it('capture and edit use dedupe, replay and one commit despite lost replies', async () => {
    const h = await setup();
    const capture = h.command('CaptureActiveWork', { name: 'New', next: 'first step' });
    h.store.writeFaults.push('apply-then-unknown');
    const first = receipt(await h.run(capture));
    expect(first.status).toBe('already-applied');
    expect(await h.run(capture)).toEqual(first);
    expect(h.store.writeCalls).toBe(1);
    const r = await h.read();
    const line = '- [ ] **New:** Next: first step';
    expect(h.store.text(PATH)).toBe(fixture.replace('\n\nProse paragraph', `\n${line}\n\nProse paragraph`));
    const edit = h.command('EditActiveWork', { item: r.items[2]!.locator, changes: { name: 'Renamed', review: '2026-10-04' } });
    const edited = receipt(await h.run(edit));
    expect(edited.effect).toMatchObject({ kind: 'active-work', op: 'edited', afterLineText: '- [ ] **Renamed:** Next: first step ⏳ 2026-10-04' });
    expect(receipt(await h.run(edit)).status).toBe('already-applied');
    expect(h.store.writeCalls).toBe(2);
    const c = await h.store.readCommit(edited.commitSha);
    expect(c?.trailers).toMatchObject({ [TRAILER_OP]: edit.operationId, [TRAILER_PAYLOAD]: await payloadHash(edit) });
  });

  it.each(['keep', 'done', 'park', 'drop'] as const)('review %s and Undo restore exact BOM/CRLF bytes, with dedupe', async (action) => {
    const text = '\uFEFF' + fixture.replaceAll('\n', '\r\n');
    const h = await setup(text);
    const r = await h.read();
    const target = h.command('ReviewActiveWork', { item: r.items[1]!.locator, action, ...(action === 'drop' ? { reason: 'stopped' } : {}) });
    const reviewed = receipt(await h.run(target));
    expect(reviewed.effect).toMatchObject({ kind: 'active-work', op: action });
    if (action === 'keep') expect(h.store.text(PATH)).toContain('⏳ 2026-10-04 [[Bike]]');
    expect(receipt(await h.run(target)).status).toBe('already-applied');
    // Unrelated files may change: equality is of this file's blob, not the branch head.
    await h.store.commitFiles({ 'Inbox/Other.md': 'other' });
    const undo = h.command('UndoActiveWork', { target, targetCommit: reviewed.commitSha });
    h.store.writeFaults.push('apply-then-unknown');
    const undone = receipt(await h.run(undo));
    expect(undone.effect).toMatchObject({ kind: 'active-work', op: 'undone' });
    expect(h.store.text(PATH)).toBe(text);
    expect(await h.run(undo)).toEqual(undone);
    expect(h.store.writeCalls).toBe(2);
    expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);
    expect(await h.run(h.command('UndoActiveWork', { target, targetCommit: reviewed.commitSha }))).toMatchObject({ code: 'conflict:task-changed' });
  });

  it('CAS replan preserves a concurrent prose edit; a changed target refuses', async () => {
    const h = await setup();
    const r = await h.read();
    const cmd = h.command('ReviewActiveWork', { item: r.items[1]!.locator, action: 'keep' });
    h.store.afterHead = async () => { h.store.afterHead = null; await h.store.commitFiles({ [PATH]: fixture.replace('One line of prose', 'Another line of prose') }); };
    receipt(await h.run(cmd));
    expect(h.store.text(PATH)).toBe(fixture.replace('One line of prose', 'Another line of prose').replace('2026-09-20', '2026-10-04'));
    expect(await h.run(h.command('EditActiveWork', { item: r.items[1]!.locator, changes: { name: 'Changed' } }))).toMatchObject({ code: 'conflict:task-changed' });
  });

  it('Undo refuses changed files, forged tokens, mismatched payloads and unbounded history', async () => {
    const h = await setup();
    const r = await h.read();
    const target = h.command('ReviewActiveWork', { item: r.items[1]!.locator, action: 'done' });
    const reviewed = receipt(await h.run(target));
    const undo = () => h.command('UndoActiveWork', { target, targetCommit: reviewed.commitSha });
    await h.store.commitFiles({ [PATH]: h.store.text(PATH)! + 'Desktop prose\n' });
    expect(await h.run(undo())).toMatchObject({ code: 'refused:undo-expired' });
    expect(h.store.writeCalls).toBe(1);
    expect(await h.run(h.command('UndoActiveWork', { target, targetCommit: h.store.headCommit }))).toMatchObject({ code: 'invalid' });
    const altered = { ...target, occurredAt: '2026-09-26T22:31:00Z' };
    expect(await h.run(h.command('UndoActiveWork', { target: altered, targetCommit: reviewed.commitSha }))).toMatchObject({ code: 'invalid' });
    h.store.comparePageSize = 0;
    expect(await h.run(undo())).toMatchObject({ code: 'dedupe-unknown' });
  });

  it('never certifies a forged review commit or its Undo without parent replay', async () => {
    const h = await setup();
    const r = await h.read();
    const target = h.command('ReviewActiveWork', { item: r.items[1]!.locator, action: 'done' });
    const forged = await h.store.writeFile({ path: PATH as VaultPath, baseCommit: h.store.headCommit, expect: 'regular-file',
      bytes: new TextEncoder().encode(fixture + 'forged\n'), message: 'synthetic forged review',
      trailers: { [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) } });
    if (!forged.ok) throw new Error('fixture write failed');
    expect(await h.run(target)).toMatchObject({ code: 'dedupe-unknown' });
    expect(await h.run(h.command('UndoActiveWork', { target, targetCommit: forged.commitSha }))).toMatchObject({ code: 'dedupe-unknown' });
  });
});
