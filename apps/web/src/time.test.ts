import { describe, expect, it } from 'vitest';
import { displayDate, isoWithOffset } from './time.ts';

describe('displayDate', () => {
  it.each([
    ['2026-10-13', '13 Oct 2026'],
    ['2026-09-23', '23 Sep 2026'],
    ['2026-01-01', '1 Jan 2026'],
    ['2024-02-29', '29 Feb 2024'],
    ['2026-03-29', '29 Mar 2026'],
    ['2026-10-25', '25 Oct 2026'],
  ])('preserves the date without a time-zone conversion: %s', (date, expected) => {
    expect(displayDate(date)).toBe(expected);
  });
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '', 'invalid', '2026-10-13T23:00:00Z'])('does not invent a day for %s', (date) => {
    expect(displayDate(date)).toBe('Date unknown');
  });
});

describe('isoWithOffset', () => {
  const instant = new Date('2026-10-24T21:59:59.123Z');

  it('renders local wall time with a positive offset (Copenhagen summer)', () => {
    expect(isoWithOffset(instant, -120)).toBe('2026-10-24T23:59:59.123+02:00');
  });

  it('renders a negative offset and crosses the date line correctly', () => {
    expect(isoWithOffset(instant, 330)).toBe('2026-10-24T16:29:59.123-05:30');
  });

  it('renders UTC as +00:00 and round-trips to the same instant', () => {
    const s = isoWithOffset(instant, 0);
    expect(s).toBe('2026-10-24T21:59:59.123+00:00');
    expect(new Date(isoWithOffset(instant)).getTime()).toBe(instant.getTime());
  });
});
