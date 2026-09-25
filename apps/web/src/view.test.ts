import { TasksResponse, type Receipt, type TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { completeTask, undoCompleteTask } from './commands.ts';
import type { ItemState, QueueItem } from './queue/queue.ts';
import { buildView, occurrenceKey } from './view.ts';

const REV = '1'.repeat(40);
const ACCOUNT = 'a'.repeat(64);
const COMMIT = '5'.repeat(40);
const OPEN = '- [ ] Water the plants 📅 2026-09-24';
const DONE = '- [x] Water the plants 📅 2026-09-24 ✅ 2026-09-24';

function task(lineText: string, lineIndex: number, done = false): TaskView {
  return {
    locator: { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex, lineText, occurrencesAtRead: 1 },
    description: 'Water the plants',
    status: done ? 'done' : 'open',
    section: done ? 'done' : 'open',
    priority: null,
    due: '2026-09-24',
    scheduled: null,
    start: null,
    created: null,
    done: done ? '2026-09-24' : null,
    recurring: false,
    readOnlyReason: null,
    links: [],
  };
}

function read(open: TaskView[], doneToday: TaskView[], known: Record<string, 'included' | 'not-included'> = {}) {
  return TasksResponse.parse({
    revision: REV,
    blobSha: '2'.repeat(40),
    today: '2026-09-24',
    timeZone: 'Europe/Copenhagen',
    writeBlock: null,
    known,
    todayTasks: open,
    overdue: [],
    allOpen: open,
    doneToday,
  });
}

const openTask = task(OPEN, 10);
const complete = completeTask({ baseRevision: REV }, openTask.locator);

function item(envelope: QueueItem['envelope'], state: ItemState, extra: Partial<QueueItem> = {}): QueueItem {
  return {
    operationId: envelope.operationId,
    seq: 1,
    type: envelope.type,
    envelope,
    label: 'Water the plants',
    taskKey: envelope.type === 'CompleteTask' ? occurrenceKey(envelope.payload.task) : null,
    accountKey: ACCOUNT,
    state,
    error: null,
    everSent: state !== 'pending',
    accountMismatch: false,
    receipt: null,
    acknowledged: false,
    ...extra,
  };
}

const completedReceipt: Receipt = {
  operationId: complete.operationId,
  status: 'applied',
  path: 'Tasks/To-Do List.md',
  commitSha: COMMIT,
  blobSha: '6'.repeat(40),
  effect: { kind: 'completed', completedLineText: DONE, openLineText: OPEN, completedInPlace: false, doneDate: '2026-09-24' },
};

describe('buildView', () => {
  it('moves a pending completion to Done today immediately', () => {
    const v = buildView(read([openTask], []), [item(complete, 'saving')]);
    expect(v.today).toEqual([]);
    expect(v.all).toEqual([]);
    expect(v.doneToday).toMatchObject([{ description: 'Water the plants', done: true, action: { state: 'saving' } }]);
  });

  it('moves a refused completion back to the open lists with its error', () => {
    const error = { code: 'conflict:task-changed', message: 'The task changed.' };
    const v = buildView(read([openTask], []), [item(complete, 'attention', { error })]);
    expect(v.doneToday).toEqual([]);
    expect(v.today).toMatchObject([{ task: openTask, action: { state: 'attention', error } }]);
  });

  it('keeps a saved completion in Done today while the read does not include its commit (F10)', () => {
    const saved = item(complete, 'saved', { receipt: completedReceipt });
    const stale = buildView(read([openTask], [], { [COMMIT]: 'not-included' }), [saved]);
    expect(stale.today).toEqual([]);
    expect(stale.doneToday).toMatchObject([{ task: null, action: { state: 'saved' } }]);

    const fresh = buildView(read([], [task(DONE, 3, true)], { [COMMIT]: 'included' }), [saved]);
    expect(fresh.doneToday).toMatchObject([{ task: { locator: { lineText: DONE } }, action: { state: 'saved' } }]);
    expect(fresh.today).toEqual([]);
  });

  it('decides reflection by the rendered read alone, never by a sticky acknowledgement (N3)', () => {
    const acknowledged = item(complete, 'saved', { receipt: completedReceipt, acknowledged: true });
    const included = buildView(read([], [task(DONE, 3, true)], { [COMMIT]: 'included' }), [acknowledged]);
    expect(included.doneToday).toMatchObject([{ task: { locator: { lineText: DONE } } }]);

    const stale = buildView(read([openTask], [], { [COMMIT]: 'not-included' }), [acknowledged]);
    expect(stale.today).toEqual([]);
    expect(stale.doneToday).toMatchObject([{ task: null, action: { state: 'saved' } }]);
  });

  it('shows a task re-opened by a live Undo even when the read still has it done', () => {
    const undo = undoCompleteTask({ baseRevision: REV }, complete);
    const items = [item(complete, 'saved', { receipt: completedReceipt }), item(undo, 'pending', { seq: 2 })];
    const v = buildView(read([], [task(DONE, 3, true)], { [COMMIT]: 'included' }), items);
    expect(v.doneToday).toEqual([]);
    expect(v.today).toMatchObject([{ task: null, done: false, action: { type: 'UndoCompleteTask', state: 'pending' } }]);
  });

  it('ignores captures for the task lists', () => {
    const v = buildView(read([openTask], []), [item(complete, 'saving', { type: 'CaptureTask', taskKey: null })]);
    expect(v.today).toMatchObject([{ task: openTask, action: null }]);
  });
});

describe('buildView with identical task lines (P4-B)', () => {
  const BLOB2 = '7'.repeat(40);
  const COMMIT2 = '8'.repeat(40);
  const at = (lineIndex: number, occurrencesAtRead: number, blobSha = '2'.repeat(40)): TaskView => {
    const t = task(OPEN, lineIndex);
    return { ...t, locator: { ...t.locator, blobSha, occurrencesAtRead } };
  };
  const done = (lineIndex: number) => task(DONE, lineIndex, true);
  const indexes = (rows: { task: TaskView | null }[]) => rows.map((r) => r.task?.locator.lineIndex ?? null);
  const a10 = at(10, 2);
  const a12 = at(12, 2);
  const c10 = completeTask({ baseRevision: REV }, a10.locator);
  const receiptOf = (c: typeof c10, commitSha: string): Receipt => ({ ...completedReceipt, operationId: c.operationId, commitSha });
  const saved10 = (extra: Partial<QueueItem> = {}) => item(c10, 'saved', { receipt: receiptOf(c10, COMMIT), ...extra });

  it('completing one of two identical open tasks leaves the other open', () => {
    const v = buildView(read([a10, a12], []), [item(c10, 'pending')]);
    expect(indexes(v.today)).toEqual([12]);
    expect(indexes(v.all)).toEqual([12]);
    expect(v.doneToday).toMatchObject([{ task: null, done: true, action: { operationId: c10.operationId } }]);
  });

  it('keeps the other task, without the action, once the completion is acknowledged', () => {
    // After the commit the twin moved up a line and the blob changed.
    const after = at(11, 1, BLOB2);
    const v = buildView(read([after], [done(40)], { [COMMIT]: 'included' }), [saved10({ acknowledged: true })]);
    expect(v.today).toMatchObject([{ task: after, action: null }]);
    expect(v.doneToday).toMatchObject([{ task: { locator: { lineText: DONE } }, action: { operationId: c10.operationId } }]);
  });

  it('hides a task in a stale read (desktop edit shifted lines) only when the locator names it unambiguously', () => {
    const unique = at(10, 1);
    const shifted = at(14, 1, BLOB2);
    const c = completeTask({ baseRevision: REV }, unique.locator);
    const one = buildView(read([shifted], []), [item(c, 'pending')]);
    expect(one.today).toEqual([]);
    expect(one.doneToday).toMatchObject([{ task: null, action: { operationId: c.operationId } }]);

    // The twins moved: the client cannot tell which one the pending completion names, so it hides neither and
    // shows the completion in its own row.
    const twins = buildView(read([at(11, 2, BLOB2), at(13, 2, BLOB2)], []), [item(c10, 'saving')]);
    expect(indexes(twins.today)).toEqual([11, 13]);
    expect(twins.doneToday).toMatchObject([{ task: null, action: { operationId: c10.operationId, state: 'saving' } }]);

    // A locator that was unique when read, against a read that now has two such lines: ambiguous as well.
    const doubled = buildView(read([at(11, 2, BLOB2), at(15, 2, BLOB2)], []), [item(c, 'pending')]);
    expect(indexes(doubled.today)).toEqual([11, 15]);
  });

  it('puts a refusal on the row it names, or on a row of its own when that is ambiguous', () => {
    const error = { code: 'conflict:task-changed', message: 'The task changed.' };
    const same = buildView(read([a10, a12], []), [item(c10, 'attention', { error })]);
    expect(same.today).toMatchObject([
      { task: a10, action: { operationId: c10.operationId, state: 'attention' } },
      { task: a12, action: null },
    ]);

    const moved = buildView(read([at(11, 2, BLOB2), at(13, 2, BLOB2)], []), [item(c10, 'attention', { error })]);
    expect(moved.today).toMatchObject([
      { task: null, done: false, action: { operationId: c10.operationId } },
      { task: { locator: { lineIndex: 11 } }, action: null },
      { task: { locator: { lineIndex: 13 } }, action: null },
    ]);
    expect(moved.doneToday).toEqual([]);
  });

  it('shows a live Undo as its own row and never hides the identical task that stayed open', () => {
    const undo = undoCompleteTask({ baseRevision: REV }, c10);
    const twin = at(11, 1, BLOB2);
    const items = [saved10(), item(undo, 'pending', { seq: 2 })];
    const v = buildView(read([twin], [done(40)], { [COMMIT]: 'included' }), items);
    expect(v.today).toMatchObject([
      { task: null, action: { type: 'UndoCompleteTask', state: 'pending' } },
      { task: twin, action: null },
    ]);
    expect(v.doneToday).toEqual([]);
  });

  it('identifies actions by their envelopes, so items stored before P4-B (text keys) resolve the same way', () => {
    const legacy = item(c10, 'pending', { taskKey: OPEN });
    const v = buildView(read([a10, a12], []), [legacy]);
    expect(indexes(v.today)).toEqual([12]);
  });

  it('lets the remaining identical task be completed after the first, and pairs no Undo it cannot tell apart', () => {
    const after = at(11, 1, BLOB2);
    const c11 = completeTask({ baseRevision: REV }, after.locator);
    const first = saved10({ acknowledged: true });
    const pending = buildView(read([after], [done(40)], { [COMMIT]: 'included' }), [first, item(c11, 'pending', { seq: 2 })]);
    expect(pending.today).toEqual([]);
    expect(pending.doneToday).toMatchObject([
      { task: null, action: { operationId: c11.operationId } },
      { task: { locator: { lineIndex: 40 } }, action: { operationId: c10.operationId }, undo: null },
    ]);
    // `undo` needs the session's account (none passed above); with it, the paired row offers Undo.
    const mine = buildView(read([after], [done(40)], { [COMMIT]: 'included' }), [first, item(c11, 'pending', { seq: 2 })], ACCOUNT);
    expect(mine.doneToday[1]?.undo).toEqual(c10);

    // Both saved and in the read: two identical done lines, two receipts. Neither row claims a receipt.
    const second = item(c11, 'saved', { seq: 2, receipt: receiptOf(c11, COMMIT2) });
    const both = buildView(read([], [done(40), done(41)], { [COMMIT]: 'included', [COMMIT2]: 'included' }), [first, second], ACCOUNT);
    expect(both.doneToday).toMatchObject([
      { action: null, undo: null },
      { action: null, undo: null },
    ]);
  });
});

describe('Undo from Done today (P4-B)', () => {
  const included = read([], [task(DONE, 40, true)], { [COMMIT]: 'included' });
  const saved = item(complete, 'saved', { receipt: completedReceipt, acknowledged: true });

  it('offers the stored completion envelope on its Done today row', () => {
    const v = buildView(included, [saved], ACCOUNT);
    expect(v.doneToday).toMatchObject([{ task: { locator: { lineText: DONE } }, undo: complete }]);
    expect(v.doneToday[0]?.undo).toBe(saved.envelope);
  });

  it('offers none for a completion of another account, without a session, or already being undone', () => {
    expect(buildView(included, [saved], 'b'.repeat(64)).doneToday[0]?.undo).toBeNull();
    expect(buildView(included, [saved], null).doneToday[0]?.undo).toBeNull();
    const undo = undoCompleteTask({ baseRevision: REV }, complete);
    const undoing = buildView(included, [saved, item(undo, 'attention', { seq: 2, error: { code: 'x', message: 'x' } })], ACCOUNT);
    expect(undoing.doneToday).toMatchObject([{ undo: null }]);
  });

  it('offers none while the task list is write-blocked (a sync conflict refuses every write)', () => {
    const blocked = TasksResponse.parse({
      ...included,
      writeBlock: { code: 'refused:vault-conflict', message: 'File contains Git conflict markers.', retryable: false },
    });
    expect(buildView(blocked, [saved], ACCOUNT).doneToday).toMatchObject([{ action: { operationId: complete.operationId }, undo: null }]);
  });

  it('offers none for a done line the device did not complete, or a completion not yet in the read', () => {
    expect(buildView(included, [], ACCOUNT).doneToday).toMatchObject([{ action: null, undo: null }]);
    const notYet = buildView(read([openTask], [], { [COMMIT]: 'not-included' }), [saved], ACCOUNT);
    expect(notYet.doneToday).toMatchObject([{ task: null, undo: null }]);
  });
});
