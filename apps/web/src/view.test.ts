import { TasksResponse, type Receipt, type TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { completeTask, undoCompleteTask } from './commands.ts';
import type { ItemState, QueueItem } from './queue/queue.ts';
import { buildView } from './view.ts';

const REV = '1'.repeat(40);
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
    taskKey: OPEN,
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

  it('stops overlaying an acknowledged receipt even when a later read no longer lists its commit (A9)', () => {
    const acknowledged = item(complete, 'saved', { receipt: completedReceipt, acknowledged: true });
    const later = buildView(read([], [task(DONE, 3, true)]), [acknowledged]);
    expect(later.doneToday).toMatchObject([{ task: { locator: { lineText: DONE } } }]);
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
