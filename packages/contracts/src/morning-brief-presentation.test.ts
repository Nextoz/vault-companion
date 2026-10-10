import { describe, expect, it } from 'vitest';
import { MorningBriefResponse } from './index.ts';
import { briefDurationText, briefTimeline } from './morning-brief-presentation.ts';

const DATE = '2026-10-02';

const meeting = (title: string, start: string, end: string, extra: Record<string, unknown> = {}) =>
  ({ title, start: `${DATE}T${start}:00+02:00`, end: `${DATE}T${end}:00+02:00`, allDay: false, clash: false, ...extra });

const file = (brief: Partial<MorningBriefResponse['brief']> = {}, unavailable: string[] = []) =>
  MorningBriefResponse.parse({
    revision: 'a'.repeat(40), date: DATE, generatedAt: `${DATE}T06:31:00+02:00`, source: 'model',
    unavailable, unavailableReasons: {}, brief: { source: 'model', dayLine: 'Synthetic day.', gaps: [], todos: [], ...brief },
  });

const NOW = new Date(`${DATE}T12:30:00+02:00`);

/** 3 meetings (one clash) + 2 gaps, deliberately out of order in the file. */
const busy = () => file({
  meetings: [
    meeting('Lunch', '11:00', '12:00'),
    meeting('Team sync', '09:30', '10:30', { clash: true, clashWith: 'Design review' }),
    meeting('Design review', '09:00', '10:00', { clash: true, clashWith: 'Team sync', link: 'https://calendar.google.com/calendar/event?eid=synthetic' }),
  ],
  gaps: [
    { blockIndex: 1, start: `${DATE}T12:00:00+02:00`, end: `${DATE}T12:45:00+02:00` },
    { blockIndex: 2, start: `${DATE}T07:00:00+02:00`, end: `${DATE}T08:00:00+02:00`, suggestion: 'Take a walk' },
  ],
});

describe('briefDurationText', () => {
  it('words minutes, whole hours and mixed lengths', () => {
    expect(briefDurationText(45)).toBe('45 min');
    expect(briefDurationText(180)).toBe('3 h');
    expect(briefDurationText(90)).toBe('1 h 30 min');
    expect(briefDurationText(0)).toBe('');
    expect(briefDurationText(Number.NaN)).toBe('');
  });
});

describe('briefTimeline', () => {
  it('renders 3 meetings + 1 clash + 2 gaps in time order', () => {
    const { rows, calendarFailed } = briefTimeline(busy(), NOW);
    expect(calendarFailed).toBe(false);
    expect(rows.map((row) => row.time)).toEqual(['07:00-08:00', '09:00-10:00', '09:30-10:30', '11:00-12:00', '12:00-12:45']);
    expect(rows.map((row) => row.kind)).toEqual(['gap', 'meeting', 'meeting', 'meeting', 'gap']);
    expect(rows[0]!.label).toBe('Free 1 h · Take a walk');
    expect(rows[4]!.label).toBe('Free 45 min');
  });

  it('gives BOTH clashing meetings a badge and the overlap line with the partner', () => {
    const { rows } = briefTimeline(busy(), NOW);
    const design = rows.find((row) => row.label === 'Design review')!;
    const sync = rows.find((row) => row.label === 'Team sync')!;
    expect(design.clashBadge).toBe('Clash');
    expect(sync.clashBadge).toBe('Clash');
    expect([design.overlapMinutes, sync.overlapMinutes]).toEqual([30, 30]);
    expect(design.overlap).toBe('Overlaps 30 min with Team sync');
    expect(sync.overlap).toBe('Overlaps 30 min with Design review');
    expect(design.link).toBe('https://calendar.google.com/calendar/event?eid=synthetic');
    expect(sync.link).toBeNull();
  });

  it('marks a row ended only when its end is before `now`', () => {
    const later = new Date(`${DATE}T13:00:00+02:00`);
    expect(briefTimeline(busy(), later).rows.map((row) => row.ended)).toEqual([true, true, true, true, true]);
    expect(briefTimeline(busy(), NOW).rows[4]!.ended).toBe(false);
    const endsAtNow = file({ meetings: [meeting('At noon', '11:00', '12:00')] });
    const opensNow = new Date(`${DATE}T12:00:00+02:00`);
    expect(briefTimeline(endsAtNow, opensNow).rows[0]!.ended).toBe(false);
  });

  it('separates all-day items and keeps the file local offset', () => {
    const withAllDay = file({ meetings: [meeting('Planning day', '00:00', '00:00', { allDay: true }), meeting('Far away', '09:00', '10:00', { start: `${DATE}T09:00:00+05:30`, end: `${DATE}T10:00:00+05:30` })] });
    const timeline = briefTimeline(withAllDay, NOW);
    expect(timeline.allDay).toEqual(['Planning day']);
    expect(timeline.rows.map((row) => row.time)).toEqual(['09:00-10:00']);
  });

  it('omits non-https calendar links', () => {
    for (const link of ['http://calendar.google.com/event', 'javascript:alert(1)', 'invalid']) {
      expect(briefTimeline(file({ meetings: [meeting('Unsafe', '09:00', '10:00', { link })] }), NOW).rows[0]!.link).toBeNull();
    }
  });

  it('yields no rows and no gap suggestions when Calendar failed', () => {
    const failed = file({ meetings: [meeting('Design review', '09:00', '10:00')], gaps: [{ blockIndex: 1, start: `${DATE}T11:00:00+02:00`, end: `${DATE}T12:00:00+02:00`, suggestion: 'Take a walk' }] }, ['calendar']);
    expect(briefTimeline(failed, NOW)).toEqual({ allDay: [], rows: [], calendarFailed: true });
  });
});
