import { readFileSync } from 'node:fs';
import { BarometerResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { parseDmiBody, parseOpenMeteoBody, projectBarometer, type DmiStation, type ModelSeries } from './barometer.ts';

// Real captures (17 Oct 2026): newest obs of both stations 06:40Z (1020.2 / 1020.27), 03:40Z 1018.9 / 1018.83;
// the model's current value is 1019.9 at 06:45Z. Weighted by 1/d^2 the stations give 1020.2437 and 1018.8562.
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/monitors/${name}`, import.meta.url), 'utf8'));
const station = (name: string): DmiStation => {
  const parsed = parseDmiBody(load(name));
  if (parsed === null || parsed === 'empty') throw new Error(name);
  return parsed;
};
const kastrup = station('dmi-pressure-06180.json');
const jaegersborg = station('dmi-pressure-06181.json');
const model = parseOpenMeteoBody(load('open-meteo-pressure-dmi.json')) as ModelSeries;
const NOW = new Date('2026-10-17T06:45:00Z');
const project = (over: Partial<Parameters<typeof projectBarometer>[0]> = {}) =>
  projectBarometer({ stations: [kastrup, jaegersborg], model, now: NOW, fetchedAt: NOW, ...over });
/** The same station with its observations shifted so the newest one is `minutes` after the real newest. */
const shifted = (s: DmiStation, minutes: number): DmiStation => ({
  ...s, obs: s.obs.map((o) => ({ ...o, timeUtc: new Date(Date.parse(o.timeUtc) + minutes * 60_000).toISOString() })),
});
/** Both real stations with every value changed by `delta`, but the 3 h history untouched: a controlled change. */
const withNewest = (delta: number): DmiStation[] => [kastrup, jaegersborg].map((s) => ({
  ...s, obs: s.obs.map((o, i) => (i === 0 ? { ...o, hPa: o.hPa + delta } : o)),
}));

describe('projectBarometer', () => {
  it('weights both fresh stations by distance and reports the change over three hours', () => {
    const result = project();
    expect(BarometerResponse.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      status: 'ok', source: 'dmi', place: 'Trianglen', hPa: 1020.2, observedAt: '2026-10-17T06:40:00.000Z',
      hPaThreeHoursAgo: 1018.9, changeHpa: 1.3, trend: 'rising', zone: 'Fair',
    });
  });

  it('uses only the fresh station when the other one went quiet', () => {
    // Kastrup's newest obs is now 75 min old; Jaegersborg reported 5 min ago.
    const result = project({ now: new Date('2026-10-17T07:55:00Z'), stations: [kastrup, shifted(jaegersborg, 70)] });
    expect(result).toMatchObject({ status: 'ok', source: 'dmi', hPa: 1020.3, observedAt: '2026-10-17T07:50:00.000Z' });
  });

  it('falls back to the labelled model only when every station is stale', () => {
    const later = new Date('2026-10-17T07:55:00Z'); // stations 75 min old
    const freshModel: ModelSeries = { ...model, currentTimeUtc: '2026-10-17T07:50:00.000Z' };
    expect(project({ now: later, model: freshModel })).toMatchObject({ status: 'ok', source: 'model', hPa: 1019.9, observedAt: '2026-10-17T07:50:00.000Z' });
    // 3 h before the model's current time is 04:50Z: between the hourly 04:00 and 05:00 rows of the real capture.
    const hourly = (time: string) => model.hourly.find((h) => h.timeUtc === time)!.hPa;
    const expected = Math.round((hourly('2026-10-17T04:00:00.000Z') * 0.1667 + hourly('2026-10-17T05:00:00.000Z') * 0.8333) * 10) / 10;
    const result = project({ now: later, model: freshModel });
    expect(result.status === 'ok' && result.hPaThreeHoursAgo).toBeCloseTo(expected, 1);
  });

  it('is unavailable (empty) when stations and model are all stale or missing', () => {
    const later = new Date('2026-10-17T07:55:00Z');
    expect(project({ now: later })).toMatchObject({ status: 'unavailable', reason: 'empty' }); // model current is 70 min old
    expect(project({ now: later, model: null })).toMatchObject({ status: 'unavailable', reason: 'empty' });
  });

  it('calls a move of exactly 1 hPa steady and more than 1 hPa rising or falling', () => {
    // newest values are 1020.2/1020.27 vs 1018.9/1018.83 three hours earlier; shift the newest to tune the change.
    expect(project({ stations: withNewest(-0.3) })).toMatchObject({ hPa: 1019.9, changeHpa: 1, trend: 'steady' });
    expect(project({ stations: withNewest(-0.5) })).toMatchObject({ hPa: 1019.7, changeHpa: 0.8, trend: 'steady' });
    expect(project({ stations: withNewest(-3) })).toMatchObject({ trend: 'falling' }); // 1017.2 vs 1018.9: -1.7
    expect(project({ stations: withNewest(0) })).toMatchObject({ trend: 'rising' });
  });

  it('leaves history, change and trend null when a station lacks the reading three hours back', () => {
    const young: DmiStation = { ...kastrup, obs: kastrup.obs.slice(0, 5) };
    const result = project({ stations: [young, jaegersborg] });
    expect(result).toMatchObject({ status: 'ok', hPaThreeHoursAgo: null, changeHpa: null, trend: null });
  });

  it('does not trust a newest observation more than 10 minutes in the future', () => {
    const future = [shifted(kastrup, 30), shifted(jaegersborg, 30)]; // newest obs 07:10Z against now 06:45Z
    expect(project({ stations: future, model: null })).toMatchObject({ status: 'unavailable', reason: 'empty' });
  });
});
