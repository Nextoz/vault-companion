import { WeekRunwayEvening, WeekRunwayPick, WeekRunwayResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { busyDaysLabel, dayParts, pickTime, rangeLabel, summaryLine, updatedLabel } from './week-runway-view.ts';

const pick = (over: Record<string, unknown> = {}): WeekRunwayPick => WeekRunwayPick.parse({
  eventId: 'a1b2c3d4e5f6a7b8c9d0', title: 'Synthetic talk', start: '2026-10-16T16:30:00Z', end: null, ...over,
});

const evening = (over: Record<string, unknown> = {}): WeekRunwayEvening => WeekRunwayEvening.parse({
  day: '2026-10-16', highTemperatureC: 12, weatherCode: 2, state: 'free', picks: [], ...over,
});

// One realistic synthetic week: Fri 16 - Thu 22 Oct 2026, 3 free / 2 busy / 2 picked.
const evenings: WeekRunwayEvening[] = [
  evening({ day: '2026-10-16' }),
  evening({ day: '2026-10-17', state: 'busy' }),
  evening({ day: '2026-10-18' }),
  evening({ day: '2026-10-19', state: 'busy' }),
  evening({ day: '2026-10-20', state: 'pick', picks: [pick({ start: '2026-10-20T15:30:00Z' })] }),
  evening({ day: '2026-10-21' }),
  evening({ day: '2026-10-22', state: 'pick', picks: [pick({ start: '2026-10-22T16:30:00Z' })] }),
];

const runway = (over: Record<string, unknown> = {}): WeekRunwayResponse => WeekRunwayResponse.parse({
  now: '2026-10-16T14:05:00Z',
  sources: { calendar: 'ok', weather: 'ok', triage: 'ok' },
  evenings,
  counts: {
    free: evenings.filter((one) => one.state === 'free').length,
    busy: evenings.filter((one) => one.state === 'busy').length,
    picked: evenings.reduce((sum, one) => sum + one.picks.length, 0),
  },
  ...over,
});

describe('week runway view helpers', () => {
  it('summarises the collapsed card, singular included', () => {
    expect(summaryLine(runway())).toBe('3 free evenings · 2 picked');
    expect(summaryLine(runway({ counts: { free: 1, busy: 0, picked: 0 } }))).toBe('1 free evening · 0 picked');
  });

  it('replaces the free count with the calendar apology when the calendar could not be read', () => {
    const r = runway({ sources: { calendar: 'unavailable', weather: 'ok', triage: 'ok' } });
    expect(summaryLine(r)).toBe('Calendar unavailable · 2 picked');
  });

  it('spans the first and last evening as "FRI 16 – THU 22"', () => {
    expect(rangeLabel(evenings)).toBe('FRI 16 – THU 22');
  });

  it('splits a plain date into the day column labels', () => {
    expect(dayParts('2026-10-16')).toEqual({ wd: 'Fri', dt: '16' });
    expect(dayParts('2026-10-25')).toEqual({ wd: 'Sun', dt: '25' });
  });

  it('labels pick clock spans: whole hours short, half hours explicit, open end alone', () => {
    expect(pickTime('2026-10-04T15:00:00Z', '2026-10-04T19:00:00Z')).toBe('17–21');
    expect(pickTime('2026-10-06T16:30:00Z', null)).toBe('18:30');
    expect(pickTime('2026-10-06T16:30:00Z', '2026-10-06T19:00:00Z')).toBe('18:30–21:00');
  });

  it('keeps Copenhagen wall time across the October 2026 DST fold', () => {
    expect(pickTime('2026-10-24T15:00:00Z', '2026-10-24T19:00:00Z')).toBe('17–21'); // Sat: CEST, UTC+2
    expect(pickTime('2026-10-25T16:00:00Z', '2026-10-25T20:00:00Z')).toBe('17–21'); // Sun: CET, UTC+1
    expect(updatedLabel('2026-10-25T00:30:00Z')).toBe('Updated 02:30'); // before the 01:00Z fold: 02:30 CEST
    expect(updatedLabel('2026-10-25T01:30:00Z')).toBe('Updated 02:30'); // after the fold: 02:30 CET
  });

  it('lists the busy evenings "Sat 17 & Mon 19", comma-joining three', () => {
    expect(busyDaysLabel(evenings)).toBe('Sat 17 & Mon 19');
    const three = [...evenings.slice(0, 5), evening({ day: '2026-10-21', state: 'busy' }), evenings[6]!];
    expect(busyDaysLabel(three)).toBe('Sat 17, Mon 19 & Wed 21');
    expect(busyDaysLabel([evening()])).toBe('');
  });

  it('stamps the footer "Updated 16:05" in Copenhagen wall time', () => {
    expect(updatedLabel('2026-10-16T14:05:00Z')).toBe('Updated 16:05');
  });
});
