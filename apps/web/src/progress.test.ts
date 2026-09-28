import type { HistoryItem, TrainingRow, TriageResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { progressWeeks, unavailable, weekOf, weekRange, weekSummary, type ProgressInputs } from './progress.ts';

type Decision = TriageResponse['decisions'][number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eventId = (n: number) => n.toString(16).padStart(20, '0');
const task = (doneDate: string, source: 'todo' | 'active-work' = 'todo'): HistoryItem => source === 'todo'
  ? { source, description: 'Synthetic task', doneDate, links: [],
      locator: { path: 'Tasks/To-Do List.md', blobSha: '1'.repeat(40), lineIndex: 1, lineText: '- [x] Synthetic task', occurrencesAtRead: 1 } }
  : { source, description: 'Synthetic project', doneDate, links: [],
      locator: { path: 'Tasks/Active Work Now.md', blobSha: '1'.repeat(40), lineIndex: 1, lineText: '- [x] **Synthetic project:**', occurrencesAtRead: 1 } };
const row = (date: string, type: string, distance = '', split = ''): TrainingRow =>
  ({ date, time: '07:00', type, distance, duration: '30', weight: '', split, note: '' });
const decision = (n: number, event: number, d: Decision['decision'], at: string, extra: Partial<Decision> = {}): Decision =>
  ({ decisionId: id(n), eventId: eventId(event), decision: d, outcome: null, undoes: null, at, title: `Synthetic event ${event}`, start: null, ...extra });
const empty: ProgressInputs = { history: [], training: [], decisions: [], notes: [] };
const TODAY = '2026-10-01'; // Thursday; week Mon 28 Sep – Sun 4 Oct

describe('weekOf (Copenhagen Monday)', () => {
  it('puts Sunday 23:30 and Monday 00:30 Copenhagen in different weeks, whatever the UTC date', () => {
    expect(weekOf('2026-10-04T23:30:00+02:00')).toBe('2026-09-28'); // 21:30Z Sunday
    expect(weekOf('2026-10-04T22:30:00Z')).toBe('2026-10-05'); // Monday 00:30 in Copenhagen, still Sunday in UTC
    expect(weekOf('2026-10-05')).toBe('2026-10-05');
    expect(weekOf('2026-10-04')).toBe('2026-09-28');
  });
  it('uses calendar dates across DST, never 7 × 24 h', () => {
    // DST ends Sun 25 Oct 2026: that week is 169 h long. Sunday 23:30 (+01:00) is still in it.
    expect(weekOf('2026-10-25T23:30:00+01:00')).toBe('2026-10-19');
    expect(weekOf('2026-10-26T00:30:00+01:00')).toBe('2026-10-26');
    // DST starts Sun 29 Mar 2026: a 167 h week.
    expect(weekOf('2026-03-29T23:30:00+02:00')).toBe('2026-03-23');
    expect(weekOf('2026-03-23T00:30:00+01:00')).toBe('2026-03-23');
  });
});

describe('progressWeeks', () => {
  it('returns eight weeks newest first and buckets each source by its date', () => {
    const weeks = progressWeeks({ ...empty, history: [task('2026-10-01'), task('2026-09-28', 'active-work'), task('2026-09-27'), task('2026-08-02')],
      notes: [{ path: 'Inbox/A - 2026-10-04.md', title: 'A', date: '2026-10-04', blobSha: '2'.repeat(40) },
        { path: 'Inbox/B.md', title: 'B', date: null, blobSha: '3'.repeat(40) }] }, TODAY);
    expect(weeks.map((w) => w.monday)).toEqual(['2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31', '2026-08-24', '2026-08-17', '2026-08-10']);
    expect(weeks[0]).toMatchObject({ sunday: '2026-10-04', tasks: [{ doneDate: '2026-10-01' }], activeWork: [{ doneDate: '2026-09-28' }], notes: [{ title: 'A' }] });
    expect(weeks[1]!.tasks).toHaveLength(1);
    expect(weeks.flatMap((w) => w.tasks ?? [])).toHaveLength(2); // 2 Aug is outside the eight weeks
  });
  it('totals km from legacy unit-less and "5.2 km" values; gym splits as evidence', () => {
    const [week] = progressWeeks({ ...empty, training: [row('2026-09-29', 'Run', '5'), row('2026-09-30', 'Run', '5.2 km'),
      row('2026-10-01', 'Run', '4.4km'), row('2026-10-02', 'Run', ''), row('2026-09-29', 'Gym', '', 'Push'), row('2026-10-01', 'Gym')] }, TODAY);
    expect(week!.runs).toMatchObject({ count: 4, km: 14.6 });
    expect(week!.gym).toMatchObject({ count: 2, splits: ['Push'] });
    expect(weekSummary(week!, true)).toBe('4 runs (14.6 km) · 2 gym');
  });
  it('counts the latest non-undone decision per event, in the week the event takes place', () => {
    const inWeek = '2026-09-30T18:00:00+02:00';
    const decisions = [
      decision(1, 1, 'go', '2026-09-20T10:00:00Z', { start: inWeek }),
      decision(2, 2, 'go', '2026-09-20T10:00:00Z', { start: inWeek }),
      decision(3, 2, 'undo', '2026-09-20T11:00:00Z', { undoes: id(2), start: inWeek }),
      decision(4, 3, 'go', '2026-09-20T10:00:00Z', { start: inWeek }),
      decision(5, 3, 'attended', '2026-10-01T08:00:00Z', { outcome: 'worth', start: inWeek }),
      decision(6, 4, 'attended', '2026-10-01T08:00:00Z', { outcome: 'missed', start: inWeek }),
      decision(7, 5, 'skip', '2026-10-01T08:00:00Z', { start: inWeek }),
      decision(8, 6, 'go', '2026-09-29T10:00:00Z'), // pre-ADR-0027 entry: no start, counted by decision time
    ];
    const [week, earlier] = progressWeeks({ ...empty, decisions }, TODAY);
    expect(week!.events!.go.map((d) => d.eventId)).toEqual([eventId(1), eventId(6)]);
    expect(week!.events!.attended.map((d) => d.eventId)).toEqual([eventId(3)]);
    expect(earlier!.events).toEqual({ go: [], attended: [] });
    expect(weekSummary(week!, true)).toBe('3 events (1 attended)');
  });
  it('marks a failed source as unavailable while the others still count', () => {
    const inputs = { ...empty, training: null, history: [task('2026-09-29')] };
    const [week] = progressWeeks(inputs, TODAY);
    expect(week).toMatchObject({ runs: null, gym: null, tasks: [{ doneDate: '2026-09-29' }] });
    expect(weekSummary(week!, true)).toBe('1 task');
    expect(unavailable(inputs)).toEqual(['Training unavailable']);
    expect(unavailable({ history: null, training: null, decisions: null, notes: null })).toEqual(
      ['Tasks unavailable', 'Training unavailable', 'Events unavailable', 'Notes unavailable']);
  });
  it('says so plainly when a week has nothing', () => {
    const [week, earlier] = progressWeeks(empty, TODAY);
    expect(weekSummary(week!, true)).toBe('Nothing recorded this week');
    expect(weekSummary(earlier!, false)).toBe('Nothing recorded');
  });
});

describe('weekRange', () => {
  it('formats within and across months', () => {
    expect(weekRange({ monday: '2026-09-21', sunday: '2026-09-27' })).toBe('21–27 Sep');
    expect(weekRange({ monday: '2026-09-28', sunday: '2026-10-04' })).toBe('28 Sep – 4 Oct');
  });
});
