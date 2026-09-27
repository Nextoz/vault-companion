import type { HistoryItem, Receipt } from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { completeTask, undoCompleteTask } from './commands.ts';
import { dayHeading, groupByDay, reopenFor } from './history.ts';
import type { QueueItem } from './queue/queue.ts';

const REV = '1'.repeat(40);
const ACCOUNT = 'a'.repeat(64);
const OPEN = '- [ ] Water the plants #todo';
const DONE = '- [x] Water the plants #todo ✅ 2026-09-26';
const todo = (lineText: string, lineIndex: number, doneDate = '2026-09-26'): HistoryItem => ({
  source: 'todo', description: 'Water the plants', doneDate, links: [],
  locator: { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex, lineText, occurrencesAtRead: 1 },
});
const aw: HistoryItem = {
  source: 'active-work', description: 'Garden plan: beds ready [[Garden Plan]]', doneDate: '2026-09-26', links: ['Garden Plan'],
  locator: { path: 'Tasks/Active Work Now.md', blobSha: '3'.repeat(40), lineIndex: 4, lineText: '- [x] **Garden plan:** beds ready [[Garden Plan]] ✅ 2026-09-26', occurrencesAtRead: 1 },
};
const complete = completeTask({ baseRevision: REV, now: new Date('2026-09-26T10:00:00Z') },
  { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex: 1, lineText: OPEN, occurrencesAtRead: 1 });
const receipt: Receipt = {
  operationId: complete.operationId, status: 'applied', path: 'Tasks/To-Do List.md', commitSha: '5'.repeat(40), blobSha: '6'.repeat(40),
  effect: { kind: 'completed', completedLineText: DONE, openLineText: OPEN, completedInPlace: false, doneDate: '2026-09-26' },
};
function queued(envelope: QueueItem['envelope'], extra: Partial<QueueItem> = {}): QueueItem {
  return { operationId: envelope.operationId, seq: 1, type: envelope.type, envelope, label: 'Water the plants', taskKey: null,
    accountKey: ACCOUNT, state: 'saved', error: null, everSent: true, accountMismatch: false, receipt: null, acknowledged: true, ...extra };
}
const saved = queued(complete, { receipt });

describe('history grouping', () => {
  it('keeps a completion queued before Copenhagen midnight under that day with Reopen after sending', () => {
    const beforeMidnight = completeTask({ baseRevision: REV, now: new Date('2026-09-26T23:59:00+02:00') }, complete.payload.task);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-27T00:01:00+02:00'));
      const sent = queued(beforeMidnight, { receipt: { ...receipt, operationId: beforeMidnight.operationId } });
      const item = todo(DONE, 5);
      const nextDay = todo('- [x] Buy seeds #todo ✅ 2026-09-27', 6, '2026-09-27');
      const history = [nextDay, item];
      const days = groupByDay(history);
      expect(days.map((day) => day.date)).toEqual(['2026-09-27', '2026-09-26']);
      expect(days[1]).toEqual({ date: '2026-09-26', heading: 'Sat 26 Sep', items: [item] });
      expect(reopenFor(item, history, [sent], ACCOUNT)).toEqual({ kind: 'undo', target: beforeMidnight });
    } finally {
      vi.useRealTimers();
    }
  });
  it('headings are the Markdown date as written, independent of the device time zone', () => {
    expect(dayHeading('2026-09-26')).toBe('Sat 26 Sep');
    expect(dayHeading('2026-01-01')).toBe('Thu 1 Jan');
  });

  it('groups consecutive dates in server order (newest first), keeping file order within a day', () => {
    const days = groupByDay([todo(DONE, 5), aw, todo('- [x] Buy seeds ✅ 2026-09-25', 6, '2026-09-25')]);
    expect(days.map((d) => [d.heading, d.items.map((i) => i.locator.lineIndex)])).toEqual([['Sat 26 Sep', [5, 4]], ['Fri 25 Sep', [6]]]);
  });
});

describe('Reopen via the existing Undo', () => {
  it('only a To-Do item this account completed and still holds a unique receipt for', () => {
    const item = todo(DONE, 5);
    expect(reopenFor(item, [item, aw], [saved], ACCOUNT)).toEqual({ kind: 'undo', target: complete });
    expect(reopenFor(aw, [item, aw], [saved], ACCOUNT)).toEqual({ kind: 'obsidian' });
    expect(reopenFor(item, [item], [], ACCOUNT)).toEqual({ kind: 'obsidian' });
    expect(reopenFor(item, [item], [saved], 'b'.repeat(64))).toEqual({ kind: 'obsidian' });
    expect(reopenFor(item, [item], [saved], null)).toEqual({ kind: 'obsidian' });
  });

  it('twins are ambiguous and an Undo already queued shows as reopening', () => {
    const item = todo(DONE, 5);
    expect(reopenFor(item, [item, todo(DONE, 7)], [saved], ACCOUNT)).toEqual({ kind: 'obsidian' });
    const undo = queued(undoCompleteTask({ baseRevision: REV }, complete, receipt.commitSha), { state: 'pending', receipt: null });
    expect(reopenFor(item, [item], [saved, undo], ACCOUNT)).toEqual({ kind: 'reopening' });
  });
});
