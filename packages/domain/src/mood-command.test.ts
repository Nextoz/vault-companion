/// <reference types="node" />
import { Command, type Receipt } from '@vault-companion/contracts';
import { expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import * as paths from './paths.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TEMPLATE = '---\ndate: {{date:YYYY-MM-DD}}\nmood:\nenergy:\nsleep:\ncheckin_at:\n---\n';
const DATE = '2026-10-01';
const DAILY_PATH = `Journal/Daily/${DATE}.md`;
const CHECKIN_AT = '2026-10-01T06:14:00.000Z';
const NOW = new Date('2026-10-01T06:20:00Z');
const payload = { date: DATE, mood: 3, energy: -3, sleep: 0.5, checkinAt: CHECKIN_AT };
const existing = ['---', 'date: 2026-10-01', 'mood: -1', 'energy: 2', 'sleep: 7', 'checkin_at: 06:14', '---', '', 'Body', ''].join('\n');
const checkedExisting = ['---', 'date: 2026-10-01', 'mood: 3', 'energy: -3', 'sleep: 0.5', 'checkin_at: 2026-10-01T06:14:00.000Z', '---', '', 'Body', ''].join('\n');
const renderedTemplate = TEMPLATE.replaceAll('{{date:YYYY-MM-DD}}', DATE);
let n = 0;

function receipt(r: Receipt | { code: string }): Receipt {
  if ('code' in r) throw new Error(r.code);
  return r;
}

async function setup(files: Record<string, string | null> = {}) {
  const store = await InMemoryStore.create({ [paths.DAILY_JOURNAL_TEMPLATE_PATH]: TEMPLATE, ...files });
  const service = createCommandService({ store, now: () => NOW, timeZone: 'Europe/Copenhagen' });
  const command = (type: string, cmdPayload: unknown) => Command.parse({
    schemaVersion: 1,
    operationId: `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`,
    type,
    payload: cmdPayload,
    baseRevision: store.headCommit,
    occurredAt: NOW.toISOString(),
  });
  const run = (cmd: Command) => service.execute(cmd, cmd);
  return { store, command, run };
}

it('MoodCheckin updates exactly the four value spans and dedupes the same operation ID', async () => {
  const h = await setup({ [DAILY_PATH]: existing });
  const cmd = h.command('MoodCheckin', payload);
  const saved = receipt(await h.run(cmd));
  expect(saved).toMatchObject({ status: 'applied', path: DAILY_PATH, effect: { kind: 'mood', op: 'checked-in' } });
  expect(h.store.text(DAILY_PATH)).toBe(checkedExisting);
  expect((await h.store.readCommit(saved.commitSha))?.trailers[TRAILER_OP]).toBe(cmd.operationId);
  expect(h.store.writeCalls).toBe(1);
  expect(await h.run(cmd)).toMatchObject({ status: 'already-applied', path: DAILY_PATH, commitSha: saved.commitSha, effect: { kind: 'mood', op: 'checked-in' } });
  expect(h.store.writeCalls).toBe(1);
});

it('MoodCheckin creates from the rendered template with expect absent and never invents a note', async () => {
  const h = await setup();
  const cmd = h.command('MoodCheckin', payload);
  const saved = receipt(await h.run(cmd));
  expect(saved).toMatchObject({ status: 'applied', path: DAILY_PATH, effect: { kind: 'mood', op: 'checked-in' } });
  const expected = renderedTemplate.replace('mood:\n', 'mood: 3\n').replace('energy:\n', 'energy: -3\n').replace('sleep:\n', 'sleep: 0.5\n').replace('checkin_at:\n', 'checkin_at: 2026-10-01T06:14:00.000Z\n');
  expect(h.store.text(DAILY_PATH)).toBe(expected);
  expect(h.store.writeCalls).toBe(1);
  expect(await h.run(cmd)).toMatchObject({ status: 'already-applied', path: DAILY_PATH, commitSha: saved.commitSha, effect: { kind: 'mood', op: 'checked-in' } });
  expect(h.store.writeCalls).toBe(1);
});

it('missing template is a typed refusal and writes nothing', async () => {
  const h = await setup({ [paths.DAILY_JOURNAL_TEMPLATE_PATH]: null });
  expect(await h.run(h.command('MoodCheckin', payload))).toMatchObject({ code: 'refused:daily-template-missing' });
  expect(h.store.writeCalls).toBe(0);
  expect(h.store.text(DAILY_PATH)).toBeNull();
});

it('UndoMoodCheckin restores the previous values byte-exactly and dedupes once', async () => {
  const h = await setup({ [DAILY_PATH]: existing });
  const target = h.command('MoodCheckin', payload);
  const logged = receipt(await h.run(target));
  const undo = h.command('UndoMoodCheckin', { target, targetCommit: logged.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone).toMatchObject({ status: 'applied', path: DAILY_PATH, effect: { kind: 'mood', op: 'undone' } });
  expect(h.store.text(DAILY_PATH)).toBe(existing);
  expect((await h.store.readCommit(undone.commitSha))?.trailers[TRAILER_UNDOES]).toBe(target.operationId);
  expect(h.store.writeCalls).toBe(2);
  expect(await h.run(undo)).toMatchObject({ status: 'already-applied', path: DAILY_PATH, commitSha: undone.commitSha, effect: { kind: 'mood', op: 'undone' } });
  expect(h.store.writeCalls).toBe(2);
  expect(await h.run(h.command('UndoMoodCheckin', { target, targetCommit: logged.commitSha }))).toMatchObject({ code: 'conflict:mood-changed' });
});

it('Undo of a created note restores the rendered template empties and never deletes the note', async () => {
  const h = await setup();
  const target = h.command('MoodCheckin', payload);
  const logged = receipt(await h.run(target));
  const undo = h.command('UndoMoodCheckin', { target, targetCommit: logged.commitSha });
  const undone = receipt(await h.run(undo));
  expect(undone).toMatchObject({ status: 'applied', effect: { kind: 'mood', op: 'undone' } });
  expect(h.store.text(DAILY_PATH)).toBe(renderedTemplate);
  expect(h.store.writeCalls).toBe(2);
});

it('Undo refuses when one of the four values changed since the check-in', async () => {
  const h = await setup({ [DAILY_PATH]: existing });
  const target = h.command('MoodCheckin', payload);
  const logged = receipt(await h.run(target));
  await h.store.commitFiles({ [DAILY_PATH]: checkedExisting.replace('mood: 3', 'mood: 2') });
  expect(await h.run(h.command('UndoMoodCheckin', { target, targetCommit: logged.commitSha }))).toMatchObject({ code: 'conflict:mood-changed' });
  expect(h.store.writeCalls).toBe(1);
});

it('prose existing value is a typed refusal and the file is untouched', async () => {
  const prose = existing.replace('mood: -1', 'mood: feeling great');
  const h = await setup({ [DAILY_PATH]: prose });
  expect(await h.run(h.command('MoodCheckin', payload))).toMatchObject({ code: 'checkin-field-unsupported' });
  expect(h.store.writeCalls).toBe(0);
  expect(h.store.text(DAILY_PATH)).toBe(prose);
});

it('daily journal path guard allows only exact valid calendar dates and no other folders', () => {
  expect(paths.dailyJournalPath(DATE)).toBe(DAILY_PATH);
  expect(paths.dailyJournalPath('2026-13-01')).toBeNull();
  expect(paths.dailyJournalPath('2026-02-29')).toBeNull();
  expect(paths.isDailyJournalPath(DAILY_PATH)).toBe(true);
  for (const p of ['Journal/Daily/../x.md', 'Journal/Daily/2026-13-01.md', 'Journal/Other/2026-10-01.md', 'Journal/Daily/2026-10-01.md/extra']) {
    expect(paths.isDailyJournalPath(p)).toBe(false);
    expect(paths.canWrite(p as VaultPath, 'create')).toBe(false);
    expect(paths.canWrite(p as VaultPath, 'update')).toBe(false);
  }
  expect(paths.canWrite(paths.parseVaultPath(DAILY_PATH)!, 'create')).toBe(true);
  expect(paths.canWrite(paths.parseVaultPath(DAILY_PATH)!, 'update')).toBe(true);
});

it('forged check-in or undo bytes cannot be certified by retry or Undo', async () => {
  const h = await setup({ [DAILY_PATH]: existing });
  const target = h.command('MoodCheckin', payload);
  const forged = await h.store.writeFile({
    path: DAILY_PATH as VaultPath,
    baseCommit: h.store.headCommit,
    expect: 'regular-file',
    bytes: new TextEncoder().encode(existing + 'forged'),
    message: 'synthetic forged check-in',
    trailers: { [TRAILER_OP]: target.operationId, [TRAILER_PAYLOAD]: await payloadHash(target) },
  });
  if (!forged.ok) throw new Error('fixture');
  expect(await h.run(target)).toMatchObject({ code: 'dedupe-unknown' });
  expect(await h.run(h.command('UndoMoodCheckin', { target, targetCommit: forged.commitSha }))).toMatchObject({ code: 'dedupe-unknown' });
});

it('receipt effects and commit messages never carry mood values or note text', async () => {
  const h = await setup({ [DAILY_PATH]: existing });
  const saved = receipt(await h.run(h.command('MoodCheckin', payload)));
  const json = JSON.stringify(saved);
  expect(saved.effect).toEqual({ kind: 'mood', op: 'checked-in' });
  expect(json).not.toContain(CHECKIN_AT);
  expect(json).not.toContain('Body');
  expect(json).not.toContain('-3');
  expect(json).not.toContain('0.5');
  expect(json).not.toContain('06:14');
  for (const message of h.store.commitMessages()) {
    expect(message).not.toContain(CHECKIN_AT);
    expect(message).not.toContain('Body');
  }
});
