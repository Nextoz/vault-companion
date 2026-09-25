import type { TaskView } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { classifyOpenTask, createCommandService } from './commands.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODAY = '2026-09-25';
const TODO = 'Tasks/To-Do List.md';
const cases: { name: string; fields: Partial<TaskView>; markers: string; expected: 'overdue' | 'today' | 'other' }[] = [
  { name: 'due today', fields: { due: TODAY }, markers: '📅 2026-09-25', expected: 'today' },
  { name: 'due tomorrow', fields: { due: '2026-09-26' }, markers: '📅 2026-09-26', expected: 'other' },
  { name: 'due yesterday', fields: { due: '2026-09-24' }, markers: '📅 2026-09-24', expected: 'overdue' },
  { name: 'scheduled in past', fields: { scheduled: '2026-09-23' }, markers: '⏳ 2026-09-23', expected: 'today' },
  { name: 'scheduled today', fields: { scheduled: TODAY }, markers: '⏳ 2026-09-25', expected: 'today' },
  { name: 'scheduled tomorrow', fields: { scheduled: '2026-09-26' }, markers: '⏳ 2026-09-26', expected: 'other' },
  { name: 'past start only', fields: { start: '2026-09-01' }, markers: '🛫 2026-09-01', expected: 'other' },
  { name: 'start today only', fields: { start: TODAY }, markers: '🛫 2026-09-25', expected: 'other' },
  { name: 'highest', fields: { priority: 'highest' }, markers: '🔺', expected: 'today' },
  { name: 'high', fields: { priority: 'high' }, markers: '⏫', expected: 'today' },
  { name: 'medium', fields: { priority: 'medium' }, markers: '🔼', expected: 'other' },
  { name: 'no signals', fields: {}, markers: '', expected: 'other' },
  { name: 'high future start', fields: { priority: 'high', start: '2026-09-26' }, markers: '⏫ 🛫 2026-09-26', expected: 'other' },
  { name: 'high future scheduled', fields: { priority: 'high', scheduled: '2026-09-26' }, markers: '⏫ ⏳ 2026-09-26', expected: 'other' },
  { name: 'high due today future start', fields: { priority: 'high', due: TODAY, start: '2026-09-26' }, markers: '⏫ 📅 2026-09-25 🛫 2026-09-26', expected: 'today' },
  { name: 'high overdue future scheduled', fields: { priority: 'high', due: '2026-09-24', scheduled: '2026-09-26' }, markers: '⏫ 📅 2026-09-24 ⏳ 2026-09-26', expected: 'overdue' },
  { name: 'past scheduled future start', fields: { scheduled: '2026-09-23', start: '2026-09-26' }, markers: '⏳ 2026-09-23 🛫 2026-09-26', expected: 'other' },
  { name: 'high past start', fields: { priority: 'high', start: '2026-09-01' }, markers: '⏫ 🛫 2026-09-01', expected: 'today' },
  { name: 'high future due', fields: { priority: 'high', due: '2026-09-26' }, markers: '⏫ 📅 2026-09-26', expected: 'today' },
  { name: 'due today future scheduled', fields: { due: TODAY, scheduled: '2026-09-26' }, markers: '📅 2026-09-25 ⏳ 2026-09-26', expected: 'today' },
];

function view(fields: Partial<TaskView>): TaskView {
  return {
    locator: { path: TODO, blobSha: 'a'.repeat(40), lineIndex: 1, lineText: '- [ ] Synthetic #todo', occurrencesAtRead: 1 },
    description: 'Synthetic', status: 'open', section: 'open', priority: null,
    due: null, scheduled: null, start: null, created: null, done: null,
    recurring: false, readOnlyReason: null, links: [], ...fields,
  };
}

describe('ordered Today rule', () => {
  it.each(cases)('$name => $expected', ({ fields, expected }) => {
    expect(classifyOpenTask(view(fields), TODAY)).toBe(expected);
  });

  it.each(cases)('done tasks never enter Today or Overdue: $name', ({ fields }) => {
    expect(classifyOpenTask(view({ ...fields, status: 'done', done: TODAY }), TODAY)).toBe('other');
  });

  it('real tasks read preserves all open tasks and groups them by the classifier', async () => {
    const text = [
      '## Open',
      ...cases.map(({ name, markers }) => `- [ ] ${name} #todo ${markers}`.trimEnd()),
      '## Done',
      ...cases.map(({ name, markers }) => `- [x] completed ${name} #todo ${markers} ✅ ${TODAY}`),
      '',
    ].join('\n');
    const store = await InMemoryStore.create({ [TODO]: text });
    const service = createCommandService({ store, now: () => new Date('2026-09-25T12:00:00Z'), timeZone: 'Europe/Copenhagen' });
    const result = await service.readTasks([]);
    if ('code' in result) throw new Error(result.code);

    expect(result.today).toBe(TODAY);
    expect(result.allOpen.map((task) => task.description)).toEqual(cases.map((c) => c.name));
    expect(result.todayTasks.map((task) => task.description)).toEqual(cases.filter((c) => c.expected === 'today').map((c) => c.name));
    expect(result.overdue.map((task) => task.description)).toEqual(cases.filter((c) => c.expected === 'overdue').map((c) => c.name));
    expect(result.todayTasks).toEqual(result.allOpen.filter((task) => classifyOpenTask(task, TODAY) === 'today'));
    expect(result.overdue).toEqual(result.allOpen.filter((task) => classifyOpenTask(task, TODAY) === 'overdue'));
    expect(result.doneToday).toHaveLength(cases.length);
    expect(result.doneToday.every((task) => classifyOpenTask(task, TODAY) === 'other')).toBe(true);
    expect(store.text(TODO)).toBe(text);
  });
});
