/// <reference types="node" />
import { Command, type Receipt } from '@vault-companion/contracts';
import { expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import * as paths from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const BACKLOG = paths.FEEDBACK_BACKLOG_PATH as VaultPath;
const NOW = new Date('2026-10-01T06:20:00Z');
const payload = { kind: 'bug' as const, text: 'Sync *breaks* [on] fast phones when | offline', screen: 'iOS Home', appVersion: '1.2.3', date: '2026-10-01' };
const note = ['# Ready', '', '## Bug backlog', '', '| Bug | Seen | Expected | Likely cause (hint) |', '| --- | --- | --- | --- |', '| **B2 - Old bug** | | | |', ''].join('\n');
const line = '| **B3 - Sync breaks on fast phones when** | 2026-10-01 iOS Home (app 1.2.3): Sync *breaks* [on] fast phones when \\| offline | | |';
const appliedNote = note.replace('| **B2 - Old bug**', `${line}\n| **B2 - Old bug**`);
let n = 0;

function receipt(r: Receipt | { code: string }): Receipt {
  if ('code' in r) throw new Error(r.code);
  return r;
}

async function setup(files: Record<string, string | Uint8Array> = {}) {
  const store = await InMemoryStore.create({ [BACKLOG]: note, ...files });
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const command = (type: string, cmdPayload: unknown) => Command.parse({
    schemaVersion: 1, operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, type,
    payload: cmdPayload, baseRevision: store.headCommit, occurredAt: NOW.toISOString(),
  });
  return { store, command, run: (cmd: Command) => service.execute(cmd, cmd) };
}

it('ReportFeedback writes one bug row and dedupes by operation ID', async () => {
  const h = await setup();
  const cmd = h.command('ReportFeedback', payload);
  const saved = receipt(await h.run(cmd));
  expect(saved).toMatchObject({ status: 'applied', path: BACKLOG, effect: { kind: 'report', op: 'reported' } });
  expect(h.store.text(BACKLOG)).toBe(appliedNote);
  expect((await h.store.readCommit(saved.commitSha))?.trailers[TRAILER_OP]).toBe(cmd.operationId);
  expect(await h.run(cmd)).toMatchObject({ status: 'already-applied', commitSha: saved.commitSha });
  expect(h.store.writeCalls).toBe(1);
});

it('ReportFeedback wish inserts after the first Candidates bullet list', async () => {
  const h = await setup({ [BACKLOG]: '# Ready\n\n## Candidates to refine next\n\n- First\n- Second\n' });
  const p = { kind: 'wish' as const, text: 'Let me *pin* [a] `note` and | keep it visible', screen: 'Android', appVersion: '2.0-beta.1', date: '2026-10-02' };
  const saved = receipt(await h.run(h.command('ReportFeedback', p)));
  expect(saved.effect).toEqual({ kind: 'report', op: 'reported' });
  expect(h.store.text(BACKLOG)).toBe('# Ready\n\n## Candidates to refine next\n\n- First\n- Second\n- **Let me pin a note and**: 2026-10-02 Android (app 2.0-beta.1): Let me *pin* [a] `note` and \\| keep it visible\n');
});

it('path guard is update-only for the exact Ready Backlog note', () => {
  expect(paths.canWrite(paths.parseVaultPath(BACKLOG)!, 'update')).toBe(true);
  expect(paths.canWrite(paths.parseVaultPath(BACKLOG)!, 'create')).toBe(false);
  for (const p of ['Projects/Vault Companion/../x.md', 'Projects/Vault Companion/Other.md', 'Projects/Other.md']) {
    expect(paths.canWrite(p as VaultPath, 'update')).toBe(false);
    expect(paths.canWrite(p as VaultPath, 'create')).toBe(false);
  }
});

it('missing note is a typed refusal and writes nothing', async () => {
  const store = await InMemoryStore.create({});
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const cmd = Command.parse({ schemaVersion: 1, operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`, type: 'ReportFeedback', payload, baseRevision: store.headCommit, occurredAt: NOW.toISOString() });
  expect(await service.execute(cmd, cmd)).toMatchObject({ code: 'refused:structure' });
  expect(store.writeCalls).toBe(0);
});

it('Undo removes exactly the written line and dedupes once', async () => {
  const h = await setup();
  const target = h.command('ReportFeedback', payload);
  const logged = receipt(await h.run(target));
  const undo = h.command('UndoReportFeedback', { target, targetCommit: logged.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone).toMatchObject({ status: 'applied', effect: { kind: 'report', op: 'undone' } });
  expect(h.store.text(BACKLOG)).toBe(note);
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);
  expect(await h.run(undo)).toMatchObject({ status: 'already-applied', commitSha: undone.commitSha });
  expect(await h.run(h.command('UndoReportFeedback', { target, targetCommit: logged.commitSha }))).toMatchObject({ code: 'conflict:report-changed' });
});

it('Undo refuses an edited or duplicated report line', async () => {
  const h = await setup();
  const target = h.command('ReportFeedback', payload);
  const logged = receipt(await h.run(target));
  await h.store.commitFiles({ [BACKLOG]: appliedNote.replace(line, `${line} edited`) });
  expect(await h.run(h.command('UndoReportFeedback', { target, targetCommit: logged.commitSha }))).toMatchObject({ code: 'conflict:report-changed' });
  const h2 = await setup();
  const target2 = h2.command('ReportFeedback', payload);
  const logged2 = receipt(await h2.run(target2));
  await h2.store.commitFiles({ [BACKLOG]: `${appliedNote}${line}\n` });
  expect(await h2.run(h2.command('UndoReportFeedback', { target: target2, targetCommit: logged2.commitSha }))).toMatchObject({ code: 'conflict:report-changed' });
});

it('forged report bytes cannot be certified by retry or Undo', async () => {
  const h = await setup();
  const target = h.command('ReportFeedback', payload);
  const forged = await h.store.writeFile({ path: BACKLOG, baseCommit: h.store.headCommit, expect: 'regular-file', bytes: new TextEncoder().encode(note + 'forged'), message: 'synthetic forged report', trailers: { [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) } });
  if (!forged.ok) throw new Error('fixture');
  expect(await h.run(target)).toMatchObject({ code: 'dedupe-unknown' });
  expect(await h.run(h.command('UndoReportFeedback', { target, targetCommit: forged.commitSha }))).toMatchObject({ code: 'dedupe-unknown' });
});

it('receipt effects and commit messages never carry report text', async () => {
  const h = await setup();
  const saved = receipt(await h.run(h.command('ReportFeedback', payload)));
  const json = JSON.stringify(saved);
  expect(saved.effect).toEqual({ kind: 'report', op: 'reported' });
  expect(json).not.toContain(payload.text);
  expect(json).not.toContain(payload.screen);
  for (const message of h.store.commitMessages()) expect(message).not.toContain(payload.text);
});
