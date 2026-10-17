import { describe, expect, it } from 'vitest';
import { arcPath, baroAria, baroCaption, baroStale, baroSummary, dialAngle, obsTime, polar } from './barometer.ts';
import type { BarometerOk } from './barometer.ts';

/** A measured, rising reading at 1020.2 hPa; tests override only the fields their rule needs. */
const ok = (over: Partial<BarometerOk> = {}): BarometerOk => ({
  status: 'ok', now: '2026-10-17T06:50:00.000Z', fetchedAt: '2026-10-17T06:45:00.000Z', source: 'dmi',
  place: 'Trianglen', hPa: 1020.2, observedAt: '2026-10-17T06:40:00.000Z', hPaThreeHoursAgo: 1018.9,
  changeHpa: 1.3, trend: 'rising', zone: 'Fair', ...over,
});

const falling = (): BarometerOk => ok({ hPa: 1008, hPaThreeHoursAgo: 1010.4, changeHpa: -2.4, trend: 'falling', zone: 'Change' });
const steady = (): BarometerOk => ok({ hPa: 1015, hPaThreeHoursAgo: 1015, changeHpa: 0, trend: 'steady', zone: 'Change' });
const noHistory = (): BarometerOk => ok({ hPaThreeHoursAgo: null, changeHpa: null, trend: null });

describe('baroSummary', () => {
  it('joins arrow and change size for rising, falling and steady', () => {
    expect(baroSummary(ok())).toBe('1020.2 hPa · ↑ 1.3 in 3 h · Fair');
    expect(baroSummary(falling())).toBe('1008.0 hPa · ↓ 2.4 in 3 h · Change');
    expect(baroSummary(steady())).toBe('1015.0 hPa · → 0.0 in 3 h · Change');
  });
  it('drops the trend clause without history; a model source ends with model', () => {
    expect(baroSummary(noHistory())).toBe('1020.2 hPa · Fair');
    expect(baroSummary(ok({ source: 'model' }))).toBe('1020.2 hPa · ↑ 1.3 in 3 h · Fair · model');
  });
});

describe('baroCaption', () => {
  it('spells the trend out, bare for steady, absent without history or a model source', () => {
    expect(baroCaption(ok())).toBe('hPa · rising 1.3 in 3 h · Fair');
    expect(baroCaption(steady())).toBe('hPa · steady · Change');
    expect(baroCaption(noHistory())).toBe('hPa · Fair');
    expect(baroCaption(ok({ source: 'model' }))).toBe('hPa · rising 1.3 in 3 h · Fair');
  });
});

describe('baroAria', () => {
  it('reads the trend aloud, bare for steady, absent without history, model adds an estimate', () => {
    expect(baroAria(ok())).toBe('Barometer 1020.2 hPa, rising 1.3 hPa in 3 hours, Fair');
    expect(baroAria(steady())).toBe('Barometer 1015.0 hPa, steady, Change');
    expect(baroAria(noHistory())).toBe('Barometer 1020.2 hPa, Fair');
    expect(baroAria(ok({ source: 'model' }))).toBe('Barometer 1020.2 hPa, rising 1.3 hPa in 3 hours, Fair, model estimate');
  });
});

describe('obsTime', () => {
  it('renders Copenhagen clock time in CEST summer and CET winter', () => {
    expect(obsTime('2026-10-17T06:40:00.000Z')).toBe('08:40');
    expect(obsTime('2026-01-15T06:40:00.000Z')).toBe('07:40');
  });
});

describe('baroStale', () => {
  it('is fresh at 29 minutes after the fetch and stale at 31', () => {
    const fetched = Date.parse('2026-10-17T06:45:00.000Z');
    expect(baroStale(ok(), fetched + 29 * 60_000)).toBe(false);
    expect(baroStale(ok(), fetched + 31 * 60_000)).toBe(true);
  });
});

describe('dialAngle', () => {
  it('scales the dial ends and mid, clamps beyond both and places 1020.2 at 54.54°', () => {
    expect(dialAngle(950)).toBe(-135);
    expect(dialAngle(1000)).toBe(0);
    expect(dialAngle(1050)).toBe(135);
    expect(dialAngle(900)).toBe(-135);
    expect(dialAngle(1100)).toBe(135);
    expect(dialAngle(1020.2)).toBeCloseTo(54.54);
  });
});

describe('polar and arcPath', () => {
  it('places points clockwise from straight up and draws a small clockwise arc', () => {
    expect(polar(150, 108, 88, 0)).toEqual([150, 20]);
    expect(polar(150, 108, 88, 90)).toEqual([238, 108]);
    expect(arcPath(150, 108, 88, -45, 45).startsWith('M')).toBe(true);
    expect(arcPath(150, 108, 88, -45, 45)).toContain(' A 88 88 0 0 1 ');
  });
});
