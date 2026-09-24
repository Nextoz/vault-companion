import { describe, expect, it } from 'vitest';
import { isoWithOffset } from './time.ts';

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
