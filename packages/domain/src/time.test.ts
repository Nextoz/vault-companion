import { describe, expect, it } from 'vitest';
import { checkOccurredAt, userDate } from './time.ts';

const TZ = 'Europe/Copenhagen';

describe('userDate (Copenhagen calendar date of an instant)', () => {
  it('uses the zone, not UTC: 22:30Z in summer is the next Copenhagen day', () => {
    expect(userDate('2026-09-24T22:30:00Z', TZ)).toBe('2026-09-25');
  });
  it('23:59 local stays today, 00:01 local is tomorrow', () => {
    expect(userDate('2026-09-24T23:59:00+02:00', TZ)).toBe('2026-09-24');
    expect(userDate('2026-09-25T00:01:00+02:00', TZ)).toBe('2026-09-25');
  });
  it('ignores the device offset (travel): New York evening is already Copenhagen tomorrow', () => {
    expect(userDate('2026-09-24T19:30:00-04:00', TZ)).toBe('2026-09-25');
  });
  it('DST end 2026-10-25: both 02:30 instants belong to the 25th', () => {
    expect(userDate('2026-10-25T02:30:00+02:00', TZ)).toBe('2026-10-25');
    expect(userDate('2026-10-25T02:30:00+01:00', TZ)).toBe('2026-10-25');
  });
  it('DST start 2027-03-28: 22:59Z on the 27th is still the 27th; 23:01Z is the 28th', () => {
    expect(userDate('2027-03-27T22:59:00Z', TZ)).toBe('2027-03-27');
    expect(userDate('2027-03-27T23:01:00Z', TZ)).toBe('2027-03-28');
  });
});

describe('checkOccurredAt', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('rejects more than 5 minutes in the future', () => {
    expect(checkOccurredAt('2026-09-24T12:05:01Z', now)).toEqual({ ok: false });
  });
  it('accepts exactly 5 minutes in the future', () => {
    expect(checkOccurredAt('2026-09-24T12:05:00Z', now)).toEqual({ ok: true, backdated: false });
  });
  it('accepts old actions and flags more than 14 days as backdated', () => {
    expect(checkOccurredAt('2026-09-10T12:00:00Z', now)).toEqual({ ok: true, backdated: false });
    expect(checkOccurredAt('2026-09-10T11:59:59Z', now)).toEqual({ ok: true, backdated: true });
  });
});
