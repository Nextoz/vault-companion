import { expect, it } from 'vitest';
import { addDays, mondayOf, weekBars, weekdayBars } from './week-chart.ts';

it('does calendar arithmetic across month and year ends', () => {
  expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  expect(mondayOf('2026-10-02')).toBe('2026-09-28'); // Friday
  expect(mondayOf('2026-10-04')).toBe('2026-09-28'); // Sunday belongs to the week before
  expect(mondayOf('2026-09-28')).toBe('2026-09-28');
});

it('counts one bar per weekday of this week and marks today', () => {
  const dates = ['2026-10-02', '2026-10-02', '2026-09-28', '2026-09-27', '2026-10-05', 'someday', '2026-10-02 x'];
  const bars = weekdayBars(dates, '2026-10-02');
  expect(bars.map((b) => b.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  expect(bars.map((b) => b.value)).toEqual([1, 0, 0, 0, 2, 0, 0]);
  expect(bars.map((b) => b.current)).toEqual([false, false, false, false, true, false, false]);
});

it('counts the last weeks oldest first, labelled by Monday, with this week current', () => {
  const bars = weekBars(['2026-10-04', '2026-09-28', '2026-09-27', '2026-08-09', '2026-08-10'], '2026-10-02', 8);
  expect(bars).toHaveLength(8);
  expect(bars[0]).toEqual({ label: '10 Aug', value: 1, current: false });
  expect(bars.at(-2)).toEqual({ label: '21 Sep', value: 1, current: false });
  expect(bars.at(-1)).toEqual({ label: '28 Sep', value: 2, current: true });
  expect(bars.reduce((n, b) => n + b.value, 0)).toBe(4); // 9 Aug is before the window
});
