import { TasksResponse, type TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { notRedoneBy, stillUnresolved, unresolvedFrom } from './attention.ts';
import { completeTask } from './commands.ts';
import { buildView } from './view.ts';

const REV = '1'.repeat(40);
const REV2 = '3'.repeat(40);
const LINE = '- [ ] Water the plants';

function task(lineIndex: number, lineText = LINE, blobSha = '2'.repeat(40)): TaskView {
  return {
    locator: { path: 'Tasks/To-Do List.md', blobSha, lineIndex, lineText, occurrencesAtRead: 1 },
    description: lineText.slice(6),
    status: 'open',
    section: 'open',
    priority: null,
    due: null,
    scheduled: null,
    start: null,
    created: null,
    done: null,
    recurring: false,
    readOnlyReason: null,
    links: [],
  };
}

const read = (revision: string, open: TaskView[]) =>
  TasksResponse.parse({
    revision,
    blobSha: open[0]?.locator.blobSha ?? '2'.repeat(40),
    today: '2026-09-24',
    timeZone: 'Europe/Copenhagen',
    vault: null,
    writeBlock: null,
    known: {},
    todayTasks: open,
    overdue: [],
    allOpen: open,
    doneToday: [],
  });

const t = task(4);
const discarded = unresolvedFrom(completeTask({ baseRevision: REV }, t.locator), 'Water the plants', read(REV, [t]));

describe('a discarded refusal is not a resolved task (P4-B addendum 3)', () => {
  it('keeps saying the task needs attention on the read it was discarded on, and on a fresh read still showing it', () => {
    expect(stillUnresolved(discarded, read(REV, [t]))).toBe(true);
    expect(stillUnresolved(discarded, null)).toBe(true);
    expect(stillUnresolved(discarded, read(REV2, [task(6, LINE, '9'.repeat(40))]))).toBe(true);
  });

  it('is settled once a fresh read shows the task changed state (done, edited or removed)', () => {
    expect(stillUnresolved(discarded, read(REV2, []))).toBe(false);
    expect(stillUnresolved(discarded, read(REV2, [task(4, '- [ ] Water the plants twice', '9'.repeat(40))]))).toBe(false);
    // Not by a read of the same revision, which cannot show a change.
    expect(stillUnresolved(discarded, read(REV, []))).toBe(true);
  });

  it('is settled when the user redoes the action on that task, not on another one', () => {
    const other = task(8, '- [ ] Call the bike shop');
    expect(notRedoneBy(discarded, t, [t, other])).toBe(false);
    expect(notRedoneBy(discarded, other, [t, other])).toBe(true);
  });

  it('marks the task row, or shows it on its own when no single row is the task', () => {
    const v = buildView(read(REV, [t]), [], null, [discarded]);
    expect(v.today).toMatchObject([{ task: t, unresolved: true }]);
    expect(v.unresolved).toEqual([]);

    const twins = [task(5, LINE, '9'.repeat(40)), task(7, LINE, '9'.repeat(40))].map((x) => ({
      ...x,
      locator: { ...x.locator, occurrencesAtRead: 2 },
    }));
    const ambiguous = buildView(read(REV2, twins), [], null, [discarded]);
    expect(ambiguous.today.map((r) => r.unresolved)).toEqual([false, false]);
    expect(ambiguous.unresolved).toEqual([discarded]);
  });
});
