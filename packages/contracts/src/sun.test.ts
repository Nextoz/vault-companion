import { describe, expect, it } from 'vitest';
import { daylightChangeSeconds, moonPhase, sunDay } from './sun.ts';

const CPH = [55.68, 12.57] as const;
const TROMSO = [69.65, 18.96] as const;
/** Reference instant for a Copenhagen wall-clock time on a date (offset given explicitly; tables in local time). */
const local = (date: string, hhmm: string, offset: '+01:00' | '+02:00') => Date.parse(`${date}T${hhmm}:00${offset}`);
const near = (iso: string, expectedMs: number) => expect(Math.abs(Date.parse(iso) - expectedMs)).toBeLessThanOrEqual(60_000);

function normal(date: string, lat: number, lon: number) {
  const sun = sunDay(date, lat, lon);
  if (sun.kind !== 'normal') throw new Error(`expected a normal day, got ${sun.kind}`);
  return sun;
}

describe('sunDay (Copenhagen)', () => {
  it('matches 16 Oct 2026', () => {
    const sun = normal('2026-10-16', ...CPH);
    near(sun.sunrise, local('2026-10-16', '07:43', '+02:00'));
    near(sun.sunset, local('2026-10-16', '18:10', '+02:00'));
    near(sun.goldenHourStart, local('2026-10-16', '17:18', '+02:00'));
    expect(Math.abs(sun.daylightMinutes - 627.3)).toBeLessThanOrEqual(1);
  });

  it('matches both solstices', () => {
    const winter = normal('2026-12-21', ...CPH);
    near(winter.sunrise, local('2026-12-21', '08:38', '+01:00'));
    near(winter.sunset, local('2026-12-21', '15:39', '+01:00'));
    const summer = normal('2026-06-21', ...CPH);
    near(summer.sunrise, local('2026-06-21', '04:27', '+02:00'));
    near(summer.sunset, local('2026-06-21', '21:59', '+02:00'));
  });

  it('keeps the 25 Oct 2026 DST day honest: local times in CET, daylight change minutes not an hour', () => {
    const sun = normal('2026-10-25', ...CPH);
    near(sun.sunrise, local('2026-10-25', '07:01', '+01:00'));
    near(sun.sunset, local('2026-10-25', '16:49', '+01:00'));
    const change = daylightChangeSeconds('2026-10-25', ...CPH);
    expect(change).toBeGreaterThanOrEqual(-300);
    expect(change).toBeLessThanOrEqual(-240);
  });

  it('reports the daily daylight change', () => {
    const change = daylightChangeSeconds('2026-10-16', ...CPH);
    expect(change).toBeGreaterThanOrEqual(-290);
    expect(change).toBeLessThanOrEqual(-250);
  });

  it('reports polar night and midnight sun instead of inventing times', () => {
    expect(sunDay('2026-12-15', ...TROMSO)).toMatchObject({ kind: 'polar-night', daylightMinutes: 0 });
    expect(sunDay('2026-06-21', ...TROMSO)).toMatchObject({ kind: 'polar-day', daylightMinutes: 1440 });
  });

  it('refuses invalid input', () => {
    expect(() => sunDay('2026-13-01', ...CPH)).toThrow(RangeError);
    expect(() => sunDay('2026-02-30', ...CPH)).toThrow(RangeError);
    expect(() => sunDay('2026-10-16', 91, 12)).toThrow(RangeError);
    expect(() => sunDay('2026-10-16', 55, 181)).toThrow(RangeError);
  });
});

describe('moonPhase', () => {
  it('tracks the October 2026 lunation', () => {
    expect(moonPhase(new Date('2026-10-10T12:00:00Z')).illumination).toBeLessThanOrEqual(0.01);
    const waxing = moonPhase(new Date('2026-10-16T12:00:00Z'));
    expect(waxing.waxing).toBe(true);
    expect(Math.abs(waxing.illumination - 0.31)).toBeLessThanOrEqual(0.02);
    expect(moonPhase(new Date('2026-10-26T12:00:00Z')).illumination).toBeGreaterThanOrEqual(0.98);
    const waning = moonPhase(new Date('2026-11-01T12:00:00Z'));
    expect(waning.waxing).toBe(false);
    expect(Math.abs(waning.illumination - 0.55)).toBeLessThanOrEqual(0.02);
  });
});
