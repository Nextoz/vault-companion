// Seam tests: command services + real Markdown kernel + synthetic fixtures + in-memory Git.
// Whole-file assertions compare against the kernel's independently hand-specified goldens.
import { Command, type Receipt, type TaskView } from '@vault-companion/contracts';
import { loadFixture } from '@vault-companion/test-vault';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const TZ = 'Europe/Copenhagen';
const NOW = new Date('2026-09-24T12:00:00Z');
const AT = '2026-09-24T14:00:00+02:00';

let store: InMemoryStore;
let svc: ReturnType<typeof createCommandService>;
let base: string;
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

beforeEach(async () => {
  store = await InMemoryStore.create({ [TODO]: loadFixture('lf/todo-list.md'), 'Inbox/Existing - 2026-09-20.md': 'x\n' });
  svc = createCommandService({ store, now: () => NOW, timeZone: TZ });
  base = store.headCommit;
});

function envelope(type: string, payload: unknown, over: Record<string, unknown> = {}) {
  return { schemaVersion: 1, operationId: uuid(), type, occurredAt: AT, baseRevision: base, payload, ...over };
}
async function run(raw: Record<string, unknown>) {
  return svc.execute(Command.parse(raw), raw);
}
async function task(description: string, nth = 0): Promise<TaskView> {
  const r = await svc.readTasks([]);
  if ('code' in r) throw new Error(r.code);
  const found = [...r.allOpen, ...r.doneToday].filter((t) => t.description.startsWith(description));
  if (!found[nth]) throw new Error(`no task ${description}`);
  return found[nth];
}
const text = () => store.text(TODO)!;
/** Desktop-style edit of task lines only: rewrites lines that START with `prefix` (prose mentions are untouched). */
const editLine = (prefix: string, replacement: string) =>
  text()
    .split('\n')
    .map((l) => (l.startsWith(prefix) ? replacement + l.slice(prefix.length) : l))
    .join('\n');
const ok = (r: Receipt | { code: string }): Receipt => {
  if ('code' in r) throw new Error(`expected receipt, got ${r.code}`);
  return r;
};

describe('read model', () => {
  it('derives open tasks, read-only reasons and revision from Markdown', async () => {
    const r = await svc.readTasks([]);
    if ('code' in r) throw new Error(r.code);
    expect(r.revision).toBe(base);
    expect(r.today).toBe('2026-09-24');
    expect(r.allOpen.find((t) => t.description.startsWith('Water the plants'))).toMatchObject({ due: '2026-09-30', readOnlyReason: null });
    expect(r.allOpen.find((t) => t.description.startsWith('Take out the recycling'))).toMatchObject({ recurring: true, readOnlyReason: 'refused:recurring' });
    expect(r.allOpen.some((t) => t.description.includes('Commented out task'))).toBe(false);
  });
});

describe('CompleteTask', () => {
  it('A1: writes exactly the golden bytes and a receipt with the durable revision', async () => {
    const t = await task('Water the plants');
    const r = ok(await run(envelope('CompleteTask', { task: t.locator })));
    expect(text()).toBe(loadFixture('lf/expected/complete-water.md'));
    expect(r).toMatchObject({ status: 'applied', path: TODO, commitSha: store.headCommit, effect: { kind: 'completed', doneDate: '2026-09-24' } });
    const after = await svc.readTasks([r.commitSha]);
    if ('code' in after) throw new Error(after.code);
    expect(after.doneToday.map((d) => d.description)).toContain('Water the plants');
    expect(after.known[r.commitSha]).toBe('included');
  });

  it('A10: lost response ⇒ the retry returns already-applied with the same commit; one durable effect', async () => {
    const t = await task('Water the plants');
    const raw = envelope('CompleteTask', { task: t.locator });
    store.writeFaults.push('apply-then-unknown');
    const first = ok(await run(raw));
    const retry = ok(await run(raw));
    expect(first.status).toBe('already-applied');
    expect(retry).toMatchObject({ status: 'already-applied', commitSha: first.commitSha, effect: first.effect });
    expect(store.commitsWithOp(raw.operationId as string)).toHaveLength(1);
    expect(text()).toBe(loadFixture('lf/expected/complete-water.md'));
  });

  it('A11: two concurrent submissions of one envelope ⇒ one commit', async () => {
    const t = await task('Water the plants');
    const raw = envelope('CompleteTask', { task: t.locator });
    const [a, b] = await Promise.all([run(raw), run(raw)]);
    expect(ok(a).commitSha).toBe(ok(b).commitSha);
    expect(store.commitsWithOp(raw.operationId as string)).toHaveLength(1);
  });

  it('A12: the same operation ID with another payload is rejected and writes nothing', async () => {
    const t = await task('Water the plants');
    const raw = envelope('CompleteTask', { task: t.locator });
    ok(await run(raw));
    const other = await task('Sort the receipts');
    const head = store.headCommit;
    const r = await run({ ...raw, payload: { task: other.locator } });
    expect(r).toMatchObject({ code: 'operation-id-reused' });
    expect(store.headCommit).toBe(head);
  });

  it('A13: safe replay after the desktop changed another task in the same file', async () => {
    const t = await task('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [ ] Call the bike shop about the gears', '- [ ] Call the bike shop about the brakes') });
    ok(await run(envelope('CompleteTask', { task: t.locator })));
    expect(text()).toContain('- [x] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01 ✅ 2026-09-24');
    expect(text()).toContain('Call the bike shop about the brakes');
  });

  it('A14: the same task edited on the desktop ⇒ conflict, nothing written', async () => {
    const t = await task('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [ ] Water the plants #todo', '- [ ] Water the plants and herbs #todo') });
    const head = store.headCommit;
    expect(await run(envelope('CompleteTask', { task: t.locator }))).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.headCommit).toBe(head);
  });

  it('A26/F2: duplicate twin completed on the desktop ⇒ conflict:ambiguous, the other twin untouched', async () => {
    const second = await task('Sort the receipts', 1);
    expect(second.locator.occurrencesAtRead).toBe(2);
    const line = '- [ ] Sort the receipts #todo ➕ 2026-09-04\n';
    await store.commitFiles({ [TODO]: text().replace(line, '') });
    const before = text();
    expect(await run(envelope('CompleteTask', { task: second.locator }))).toMatchObject({ code: 'conflict:ambiguous' });
    expect(text()).toBe(before);
  });

  it('A7: recurring task is refused', async () => {
    const t = await task('Take out the recycling');
    expect(await run(envelope('CompleteTask', { task: t.locator }))).toMatchObject({ code: 'refused:recurring' });
  });

  it('A17/A38: future clock skew is rejected; a pre-midnight action uploaded after midnight keeps its day', async () => {
    const t = await task('Water the plants');
    expect(await run(envelope('CompleteTask', { task: t.locator }, { occurredAt: '2026-09-24T12:06:00Z' }))).toMatchObject({ code: 'clock-skew' });
    const late = createCommandService({ store, now: () => new Date('2026-09-24T22:10:00Z'), timeZone: TZ });
    const raw = envelope('CompleteTask', { task: t.locator }, { occurredAt: '2026-09-24T23:59:30+02:00' });
    const r = ok(await late.execute(Command.parse(raw), raw));
    expect(r.effect).toMatchObject({ doneDate: '2026-09-24' });
  });
});

describe('UndoCompleteTask', () => {
  async function complete(description: string) {
    const t = await task(description);
    const raw = envelope('CompleteTask', { task: t.locator });
    return { raw, receipt: ok(await run(raw)) };
  }

  it('A3: exact inverse restores the original bytes', async () => {
    const original = text();
    const { raw } = await complete('Water the plants');
    const r = ok(await run(envelope('UndoCompleteTask', { target: raw })));
    expect(r.effect).toMatchObject({ kind: 'reopened' });
    expect(text()).toBe(original);
  });

  it('A4: undo after an unrelated desktop edit keeps that edit', async () => {
    const { raw } = await complete('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [ ] Call the bike shop about the gears', '- [ ] Call the bike shop about the brakes') });
    ok(await run(envelope('UndoCompleteTask', { target: raw })));
    expect(text()).toContain('- [ ] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01\n');
    expect(text()).not.toContain('Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01 ✅');
    expect(text()).toContain('about the brakes');
  });

  it('A5: completed line edited afterwards ⇒ conflict, nothing written', async () => {
    const { raw } = await complete('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [x] Water the plants', '- [x] Water all the plants') });
    const head = store.headCommit;
    expect(await run(envelope('UndoCompleteTask', { target: raw }))).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.headCommit).toBe(head);
  });

  it('A28: a forged target (altered after the fact) is rejected', async () => {
    const { raw } = await complete('Water the plants');
    const forged = { ...raw, occurredAt: '2026-09-23T10:00:00+02:00' };
    const before = text();
    expect(await run(envelope('UndoCompleteTask', { target: forged }))).toMatchObject({ code: 'invalid' });
    expect(text()).toBe(before);
  });

  it('A27: undo of a completion that never reached Git ⇒ nothing to undo', async () => {
    const t = await task('Water the plants');
    const neverSent = envelope('CompleteTask', { task: t.locator });
    const before = text();
    expect(await run(envelope('UndoCompleteTask', { target: neverSent }))).toMatchObject({ code: 'conflict:task-changed' });
    expect(text()).toBe(before);
  });

  it('undo retried after a lost response ⇒ one reopen', async () => {
    const original = text();
    const { raw } = await complete('Water the plants');
    const undo = envelope('UndoCompleteTask', { target: raw });
    store.writeFaults.push('apply-then-unknown');
    ok(await run(undo));
    ok(await run(undo));
    expect(store.commitsWithOp(undo.operationId as string)).toHaveLength(1);
    expect(text()).toBe(original);
  });
});

describe('CaptureTask', () => {
  it('ADR-0010: inserts at the top of Open with the golden bytes', async () => {
    const r = ok(await run(envelope('CaptureTask', { text: 'Call the bike shop', context: '[[Projects/Bikes|bikes]]', priority: 'high', due: '2026-10-02' })));
    expect(text()).toBe(loadFixture('lf/expected/capture-full.md'));
    expect(r.effect).toMatchObject({ kind: 'task-captured' });
  });

  it('lost response on capture ⇒ exactly one line', async () => {
    const raw = envelope('CaptureTask', { text: 'Buy stamps' });
    store.writeFaults.push('apply-then-unknown');
    ok(await run(raw));
    ok(await run(raw));
    expect(text().split('\n').filter((l) => l.startsWith('- [ ] Buy stamps'))).toHaveLength(1);
  });

  it('text that is empty after sanitisation is refused as invalid, not a crash', async () => {
    const raw = envelope('CaptureTask', { text: '\u0001\u0002' });
    expect(await run(raw)).toMatchObject({ code: 'invalid' });
  });
});

describe('CaptureNote', () => {
  it('creates a new Inbox note with verbatim text; a retry is deduplicated', async () => {
    const raw = envelope('CaptureNote', { text: 'Idea for the garden\nsee https://example.com/a?b=c' });
    const r = ok(await run(raw));
    expect(r.path).toBe('Inbox/Idea for the garden - 2026-09-24.md');
    expect(store.text(r.path)).toContain('\nIdea for the garden\nsee https://example.com/a?b=c\n');
    const again = ok(await run(raw));
    expect(again).toMatchObject({ status: 'already-applied', path: r.path, commitSha: r.commitSha });
  });

  it('A30: a case-variant name already in Inbox ⇒ suffix (2), never an overwrite', async () => {
    const r = ok(await run(envelope('CaptureNote', { text: 'EXISTING' }, { occurredAt: '2026-09-20T10:00:00+02:00' })));
    expect(r.path).toBe('Inbox/EXISTING - 2026-09-20 (2).md');
    expect(store.text('Inbox/Existing - 2026-09-20.md')).toBe('x\n');
  });
});
