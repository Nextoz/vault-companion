import { TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import {
  canPick, calendarLines, MAX_PICKS, nextStep, NO_CALENDAR, NO_OPEN_TASKS, NOTHING_NEEDS_YOU, pickCounter, pickedTasks,
  pickRows, plannedCount, prevStep, REVIEW_STEPS, togglePick, type ReviewStep,
} from './morning-review.ts';
import type { BriefLine } from './morning-card.ts';

const BLOB = 'b'.repeat(40);
const TODAY = '2026-10-03';

const task = (lineIndex: number, over: Partial<TaskView> = {}): TaskView =>
  TaskView.parse({
    locator: { path: 'Tasks/To-Do List.md', blobSha: BLOB, lineIndex, lineText: `Task ${lineIndex}`, occurrencesAtRead: 1 },
    description: `Task ${lineIndex}`,
    status: 'open', section: 'open', priority: null, due: null, scheduled: null,
    start: null, created: null, done: null, recurring: false, readOnlyReason: null, links: [],
    ...over,
  });

const briefLine = (id: string, text: string, over: Partial<BriefLine> = {}): BriefLine =>
  ({ id, text, marker: false, todo: false, ...over });

const ids = (set: ReadonlySet<string>) => [...set].sort();

describe('NY2 review step order', () => {
  it('walks calendar -> needs -> pick -> done and back', () => {
    expect(REVIEW_STEPS).toEqual(['calendar', 'needs', 'pick', 'done']);
    const walked: ReviewStep[] = ['calendar'];
    for (let i = 0; i < 5; i += 1) walked.push(nextStep(walked[walked.length - 1]!));
    expect(walked).toEqual(['calendar', 'needs', 'pick', 'done', 'done', 'done']);
    expect(prevStep('calendar')).toBe('calendar');
    expect(prevStep('pick')).toBe('needs');
    expect(prevStep('done')).toBe('pick');
  });
});

describe('NY2 step 1 calendar projection', () => {
  it('keeps only the day line and free-block rows, in order', () => {
    const brief = [
      briefLine('fallback', 'Fallback brief', { marker: true }),
      briefLine('day', 'A calm Thursday.'),
      briefLine('state', 'Low energy.'),
      briefLine('gap-0', '09:00-10:30  Deep work'),
      briefLine('todo-1', 'Pay the bill', { todo: true }),
      briefLine('encouragement', 'You have got this.'),
    ];
    expect(calendarLines(brief)).toEqual(['A calm Thursday.', '09:00-10:30  Deep work']);
  });

  it('renders the honest empty line when there is no usable brief', () => {
    expect(NO_CALENDAR).toBe('No calendar data today');
    expect(calendarLines(null)).toEqual([NO_CALENDAR]);
    expect(calendarLines([])).toEqual([NO_CALENDAR]);
  });
});

describe('NY2 step 3 eligibility', () => {
  it('offers open tasks, flagging an already-today task without making it pickable', () => {
    const rows = pickRows([task(1), task(2, { scheduled: TODAY }), task(3, { scheduled: '2026-10-04' })], TODAY);
    expect(rows.map((row) => [row.text, row.alreadyToday])).toEqual([
      ['Task 1', false],
      ['Task 2', true],
      ['Task 3', false],
    ]);
    const already = rows[1]!;
    expect(canPick(rows, new Set(), already.id)).toBe(false);
    expect(ids(togglePick(rows, new Set(), already.id))).toEqual([]);
    expect(pickedTasks(rows, new Set([already.id]))).toEqual([]);
  });

  it('does not call a task on another day already-today', () => {
    const [row] = pickRows([task(1, { scheduled: '2026-10-04' })], TODAY);
    expect(row!.alreadyToday).toBe(false);
    expect(canPick([row!], new Set(), row!.id)).toBe(true);
  });

  it('has an honest empty pick list, and its empty text', () => {
    expect(NO_OPEN_TASKS).toBe('No open tasks');
    expect(NOTHING_NEEDS_YOU).toBe('Nothing needs you');
    expect(pickRows([], TODAY)).toEqual([]);
    expect(pickCounter([], new Set())).toBe('0 of 3');
  });
});

describe('NY2 max-3 pick rule', () => {
  const rows = pickRows([task(1), task(2), task(3), task(4)], TODAY);

  it('never lets a fourth task be picked', () => {
    let marked: ReadonlySet<string> = new Set();
    for (const row of rows.slice(0, MAX_PICKS)) marked = togglePick(rows, marked, row.id);
    expect(pickedTasks(rows, marked).map((t) => t.description)).toEqual(['Task 1', 'Task 2', 'Task 3']);
    expect(pickCounter(rows, marked)).toBe('3 of 3');
    marked = togglePick(rows, marked, rows[3]!.id);
    expect(pickedTasks(rows, marked)).toHaveLength(3);
    expect(marked.has(rows[3]!.id)).toBe(false);
  });

  it('frees a slot when a pick is unmarked', () => {
    const three = new Set(rows.slice(0, 3).map((row) => row.id));
    const two = togglePick(rows, three, rows[1]!.id);
    expect(pickedTasks(rows, two).map((t) => t.description)).toEqual(['Task 1', 'Task 3']);
    const threeAgain = togglePick(rows, two, rows[3]!.id);
    expect(pickedTasks(rows, threeAgain).map((t) => t.description)).toEqual(['Task 1', 'Task 3', 'Task 4']);
  });

  it('counts already-today tasks against the three', () => {
    const mixed = pickRows([task(1, { scheduled: TODAY }), task(2, { scheduled: TODAY }), task(3), task(4)], TODAY);
    expect(plannedCount(mixed, new Set())).toBe(2);
    expect(pickCounter(mixed, new Set())).toBe('2 of 3');
    const marked = togglePick(mixed, new Set(), mixed[2]!.id);
    expect(pickCounter(mixed, marked)).toBe('3 of 3');
    expect(canPick(mixed, marked, mixed[3]!.id)).toBe(false);

    const full = pickRows([task(1, { scheduled: TODAY }), task(2, { scheduled: TODAY }), task(3, { scheduled: TODAY }), task(4)], TODAY);
    expect(canPick(full, new Set(), full[3]!.id)).toBe(false);
  });
});
