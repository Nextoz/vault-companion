// Seam tests: command services + real Markdown kernel + synthetic fixtures + in-memory Git.
// Whole-file assertions compare against the kernel's independently hand-specified goldens.
import { Command, type Receipt, type TaskView } from '@vault-companion/contracts';
import { loadFixture } from '@vault-companion/test-vault';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCommandService } from './commands.ts';
import { payloadHash } from './payload-hash.ts';
import { TRAILER_OP, TRAILER_PAYLOAD, type VaultPath } from './store.ts';
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

describe('UndoCompleteTask (token, ADR-0013)', () => {
  async function complete(description: string) {
    const t = await task(description);
    const raw = envelope('CompleteTask', { task: t.locator });
    return { raw, receipt: ok(await run(raw)) };
  }
  const undoOf = (c: { raw: Record<string, unknown>; receipt: Receipt }, over: Record<string, unknown> = {}) =>
    envelope('UndoCompleteTask', { target: c.raw, targetCommit: c.receipt.commitSha, ...over });

  it('A3: exact inverse restores the original bytes', async () => {
    const original = text();
    const c = await complete('Water the plants');
    const r = ok(await run(undoOf(c)));
    expect(r.effect).toMatchObject({ kind: 'reopened' });
    expect(text()).toBe(original);
  });

  it('A4: semantic inverse after an unrelated desktop edit keeps that edit', async () => {
    const c = await complete('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [ ] Call the bike shop about the gears', '- [ ] Call the bike shop about the brakes') });
    ok(await run(undoOf(c)));
    expect(text()).toContain('- [ ] Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01\n');
    expect(text()).not.toContain('Water the plants #todo 📅 2026-09-30 ➕ 2026-09-01 ✅');
    expect(text()).toContain('about the brakes');
  });

  it('A5: completed line edited afterwards ⇒ conflict, nothing written', async () => {
    const c = await complete('Water the plants');
    await store.commitFiles({ [TODO]: editLine('- [x] Water the plants', '- [x] Water all the plants') });
    const head = store.headCommit;
    expect(await run(undoOf(c))).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.headCommit).toBe(head);
  });

  it('A28: a forged target (altered after the fact) does not match the token commit’s payload hash', async () => {
    const c = await complete('Water the plants');
    const forged = { ...c.raw, occurredAt: '2026-09-23T10:00:00+02:00' };
    const before = text();
    expect(await run(undoOf(c, { target: forged }))).toMatchObject({ code: 'invalid' });
    expect(text()).toBe(before);
  });

  it('a forged token naming another operation’s commit is refused, never trusted', async () => {
    const c = await complete('Water the plants');
    const other = await complete('Call the bike shop');
    const before = text();
    expect(await run(undoOf(c, { targetCommit: other.receipt.commitSha }))).toMatchObject({ code: 'invalid' });
    // A commit without app trailers (the seed) is no better.
    expect(await run(undoOf(c, { targetCommit: base }))).toMatchObject({ code: 'invalid' });
    expect(text()).toBe(before);
  });

  it('A27: a token naming no commit ⇒ nothing to undo', async () => {
    const t = await task('Water the plants');
    const neverSent = envelope('CompleteTask', { task: t.locator });
    const before = text();
    expect(await run(envelope('UndoCompleteTask', { target: neverSent, targetCommit: 'f'.repeat(40) }))).toMatchObject({ code: 'conflict:task-changed' });
    expect(text()).toBe(before);
  });

  it('a token that is not an ancestor of head is refused, even when head holds the same bytes', async () => {
    const c = await complete('Water the plants');
    const completedText = text();
    store.rewindHead(1); // C rewritten away…
    await store.commitFiles({ [TODO]: completedText }); // …and the same completed file committed by someone else
    const head = store.headCommit;
    expect(await run(undoOf(c))).toMatchObject({ code: 'conflict:task-changed' });
    expect(store.headCommit).toBe(head);
  });

  it('a token commit with the right payload hash but another operation ID is refused', async () => {
    const c = await complete('Water the plants');
    const completedText = text();
    store.rewindHead(1);
    // The very same change, recorded under another operation ID: only the Op trailer tells them apart.
    const crafted = await store.writeFile({
      path: TODO as VaultPath,
      baseCommit: store.headCommit,
      expect: 'regular-file',
      bytes: new TextEncoder().encode(completedText),
      message: 'crafted',
      trailers: { [TRAILER_OP]: uuid(), [TRAILER_PAYLOAD]: await payloadHash(c.raw) },
    });
    if (!crafted.ok) throw new Error('write failed');
    expect(await run(undoOf(c, { targetCommit: crafted.commitSha }))).toMatchObject({ code: 'invalid' });
    expect(store.headCommit).toBe(crafted.commitSha);
  });

  it('a token commit with the right trailers but other content (not the completion) cannot be verified', async () => {
    const t = await task('Water the plants');
    const target = envelope('CompleteTask', { task: t.locator });
    const other = ok(await run(envelope('CompleteTask', { task: (await task('Call the bike shop')).locator })));
    // A commit claiming to be `target` but holding a different change (here: the bike-shop completion's bytes).
    const crafted = await store.writeFile({
      path: TODO as VaultPath,
      baseCommit: store.headCommit,
      expect: 'regular-file',
      bytes: new TextEncoder().encode(store.text(TODO, other.commitSha)! + '\n'),
      message: 'crafted',
      trailers: { [TRAILER_OP]: target.operationId as string, [TRAILER_PAYLOAD]: await payloadHash(target) },
    });
    if (!crafted.ok) throw new Error('write failed');
    const head = store.headCommit;
    expect(await run(envelope('UndoCompleteTask', { target, targetCommit: crafted.commitSha }))).toMatchObject({ code: 'dedupe-unknown' });
    expect(store.headCommit).toBe(head);
  });

  it('lost-response retry of the Undo ⇒ already-applied with the same commit, one reopen', async () => {
    const original = text();
    const c = await complete('Water the plants');
    const undo = undoOf(c);
    store.writeFaults.push('apply-then-unknown');
    const first = ok(await run(undo));
    const again = ok(await run(undo));
    expect(again).toMatchObject({ status: 'already-applied', commitSha: first.commitSha, effect: first.effect });
    expect(store.commitsWithOp(undo.operationId as string)).toHaveLength(1);
    expect(text()).toBe(original);
  });

  it('a second Undo of the same completion is refused', async () => {
    const c = await complete('Water the plants');
    ok(await run(undoOf(c)));
    const after = text();
    expect(await run(undoOf(c))).toMatchObject({ code: 'conflict:task-changed' });
    expect(text()).toBe(after);
  });

  it('beyond one compare page since the completion ⇒ refused:undo-expired, nothing written; exactly one page still works', async () => {
    store.comparePageSize = 3;
    const c = await complete('Water the plants');
    for (let i = 0; i < 3; i++) await store.commitFiles({ [`Inbox/other ${i}.md`]: `${i}\n` });
    // Three commits since C: the page holds them all.
    const inPage = await (async () => {
      const probe = await store.commitsSince(c.receipt.commitSha, store.headCommit);
      return probe.kind;
    })();
    expect(inPage).toBe('ok');
    await store.commitFiles({ 'Inbox/other 3.md': '3\n' });
    const head = store.headCommit;
    expect(await run(undoOf(c))).toMatchObject({ code: 'refused:undo-expired', retryable: false });
    expect(store.headCommit).toBe(head);

    store.comparePageSize = 5;
    ok(await run(undoOf(c)));
  });

  it('call budget: one attempt makes ≤ 10 store calls and no paged search', async () => {
    const c = await complete('Water the plants');
    await store.commitFiles({ 'Inbox/other.md': 'o\n' });
    store.calls.length = 0;
    ok(await run(undoOf(c)));
    expect(store.calls.length).toBeLessThanOrEqual(10);
    expect(store.calls).not.toContain('findOperation');
    expect(store.calls.filter((k) => k === 'commitsSince')).toHaveLength(1);
  });

  it('at most 3 attempts when the head keeps moving', async () => {
    const c = await complete('Water the plants');
    let i = 0;
    store.afterHead = async () => {
      store.afterHead = null; // land one desktop commit per attempt, after X is pinned
      await store.commitFiles({ [`Inbox/race ${i++}.md`]: 'r\n' });
      store.afterHead = hook;
    };
    const hook = store.afterHead;
    const writes = store.writeCalls;
    expect(await run(undoOf(c))).toMatchObject({ code: 'conflict:stale', retryable: true });
    expect(store.writeCalls - writes).toBe(3);
    expect(store.calls.filter((k) => k === 'head').length).toBeGreaterThanOrEqual(3);
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
