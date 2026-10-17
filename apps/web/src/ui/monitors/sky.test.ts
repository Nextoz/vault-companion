import { sunDay } from '@vault-companion/contracts';
import type { KpPoint, WeatherPoint } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { bestDaylightWalk, changeLabel, daylightSummary, formatDuration, kpLabel, moonLabel, skySun, sunsetIn } from './sky.ts';

/** Copenhagen's fixed fallback coordinates: what `skySun(null, ...)` resolves to. */
const fallback = { latitude: 55.68, longitude: 12.57 };

/** One synthetic hourly point for 2026-10-16; only the rain column matters to the walk. */
const point = (hour: number, rainMm: number | null): WeatherPoint => ({
  time: new Date(Date.UTC(2026, 9, 16, hour)).toISOString(),
  temperatureC: null,
  rainMm,
  windMs: null,
  windDirectionDeg: null,
  precipitationProbabilityPct: null,
  weatherCode: null,
});

/** 24 hourly points for the day, rain by hour. */
const hourly = (rain: (hour: number) => number | null): WeatherPoint[] => {
  const points: WeatherPoint[] = [];
  for (let hour = 0; hour < 24; hour++) points.push(point(hour, rain(hour)));
  return points;
};

/** 0 mm at 11:00Z and 12:00Z, 0.5 mm everywhere else. */
const mostlyDry = (hour: number): number | null => (hour === 11 || hour === 12 ? 0 : 0.5);

describe('sky monitor helpers', () => {
  it('formats whole-minute durations', () => {
    expect(formatDuration(611)).toBe('10 h 11 min');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(120)).toBe('2 h 0 min');
  });

  it('labels the change in daylight', () => {
    expect(changeLabel(-290)).toBe('-4 min 50 s per day');
    expect(changeLabel(65)).toBe('+1 min 5 s per day');
    expect(changeLabel(0)).toBe('no change per day');
  });

  it('summarises the Copenhagen fallback day', () => {
    const { date, sun } = skySun(null, new Date('2026-10-16T14:00:00Z'));
    expect(date).toBe('2026-10-16');
    // 16 Oct 2026: 10 h 27 min of daylight, sunset 18:10 local.
    expect(daylightSummary(sun)).toMatch(/^10 h \d+ min daylight · sunset 18:1\d$/);
    expect(daylightSummary(sun).startsWith('10 h 2')).toBe(true);
    expect(sunsetIn(sun, Date.parse('2026-10-16T06:00:00Z'))).toBe('10 h 10 min');
    expect(sunsetIn(sun, Date.parse('2026-10-16T16:30:00Z'))).toBe(null);
  });

  it('names the polar cases', () => {
    const polar = sunDay('2026-12-15', 69.65, 18.96);
    expect(daylightSummary(polar)).toBe('Polar night');
    expect(sunsetIn(polar, Date.parse('2026-12-15T12:00:00Z'))).toBe(null);
    expect(bestDaylightWalk([], polar, Date.parse('2026-12-15T12:00:00Z'))).toBe(null);
  });

  it('picks the driest two-hour window in daylight', () => {
    const sun = sunDay('2026-10-16', fallback.latitude, fallback.longitude);
    const walk = bestDaylightWalk(hourly(mostlyDry), sun, Date.parse('2026-10-16T06:00:00Z'));
    expect(walk).toEqual({ start: '2026-10-16T11:00:00.000Z', end: '2026-10-16T13:00:00.000Z', rainMm: 0, dry: true });
  });

  it('never starts a window before now', () => {
    const sun = sunDay('2026-10-16', fallback.latitude, fallback.longitude);
    const now = Date.parse('2026-10-16T12:00:00Z');
    const walk = bestDaylightWalk(hourly(mostlyDry), sun, now);
    expect(walk === null || Date.parse(walk.start) >= now).toBe(true);
  });

  it('breaks windows over a null rain hour', () => {
    const sun = sunDay('2026-10-16', fallback.latitude, fallback.longitude);
    // Hour 11 is a gap, so the windows starting at 10:00Z and 11:00Z are gone; the next-driest (12:00Z) wins.
    const gap = (hour: number): number | null => (hour === 11 ? null : mostlyDry(hour));
    const walk = bestDaylightWalk(hourly(gap), sun, Date.parse('2026-10-16T06:00:00Z'));
    expect(walk).toEqual({ start: '2026-10-16T12:00:00.000Z', end: '2026-10-16T14:00:00.000Z', rainMm: 0.5, dry: false });
  });

  it('labels the Kp index and the moon', () => {
    const kp: KpPoint = { time: '2026-10-16T12:00:00Z', kp: 3.33, kind: 'observed' };
    expect(kpLabel(kp)).toEqual({ value: 'Kp 3', level: 'aurora · low' });
    expect(kpLabel(null)).toBe(null);
    expect(moonLabel(new Date('2026-10-16T12:00:00Z'))).toEqual({ value: '31 %', sub: 'moon waxing' });
  });
});
