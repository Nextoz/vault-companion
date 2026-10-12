import {
  WeatherModelSeries,
  WeatherRunWindow,
  WeatherWeekDay,
  type WeatherWeekDay as WeekDay,
} from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import {
  bestRunDay,
  bestRunSummary,
  dayDateLabel,
  dayRunSummary,
  dayScale,
  dayHours,
  modelCountLabel,
  modelDayHours,
  rainBar,
  rainLabel,
  rainSummary,
  rowDayLabel,
  runWindowHours,
  scalePercent,
  weekBar,
  weekFootnote,
  weekRainMode,
  weekScale,
  weatherCodeLabel,
  weatherGlyph,
  type DayHour,
} from './weather-week.ts';

const runWindow = (over: Record<string, unknown> = {}) => WeatherRunWindow.parse({
  day: '2026-10-15', daytimeStart: '08:00', daytimeEnd: '20:00',
  start: '2026-10-15T06:00:00Z', end: '2026-10-15T08:00:00Z',
  agreement: 'two-models', models: ['dmi_harmonie_arome_europe', 'ecmwf_ifs'], rainMm: 0.3,
  rainRangeMm: { min: 0.2, max: 0.4 }, temperatureRangeC: { min: 8, max: 10 }, windRangeMs: { min: 2, max: 4 },
  note: 'Lowest-rain two-hour window.', ...over,
});

const weekDay = (over: Record<string, unknown> = {}): WeekDay => WeatherWeekDay.parse({
  day: '2026-10-15', lowTemperatureC: 8, highTemperatureC: 14, rainMm: 0.4, precipitationProbabilityPct: 60,
  weatherCode: 3, models: 2, partial: false, runWindow: runWindow(), ...over,
});

const series = (
  model: 'dmi_harmonie_arome_europe' | 'ecmwf_ifs',
  startIso: string,
  hours: number,
  shape: (index: number) => Record<string, unknown> = () => ({}),
): WeatherModelSeries => WeatherModelSeries.parse({
  model, label: model === 'ecmwf_ifs' ? 'ECMWF IFS 9 km' : 'DMI HARMONIE AROME Europe',
  resolutionKm: model === 'ecmwf_ifs' ? 9 : 2, sourceUrl: 'https://example.test/s', retrievedAt: '2026-10-15T00:00:00Z',
  expectedPoints: model === 'ecmwf_ifs' ? 168 : 72, missingIntervals: 0,
  points: Array.from({ length: hours }, (_, index) => ({
    time: new Date(Date.parse(startIso) + index * 3_600_000).toISOString(),
    temperatureC: 10, rainMm: 0, windMs: 2, windDirectionDeg: 180, precipitationProbabilityPct: 20, weatherCode: 1,
    ...shape(index),
  })),
});

describe('week scale and bar math', () => {
  it('shares one low/high scale across all week days', () => {
    const scale = weekScale([weekDay({ day: '2026-10-15', lowTemperatureC: 4, highTemperatureC: 9 }), weekDay({ day: '2026-10-16', lowTemperatureC: 12, highTemperatureC: 18 })]);
    expect(scale).toEqual({ min: 4, max: 18 });
    expect(scalePercent(4, scale)).toBe(0);
    expect(scalePercent(18, scale)).toBe(100);
    expect(scalePercent(11, scale)).toBeCloseTo(50, 5);
  });

  it('positions a day bar on the shared scale and returns null when a bound is a gap', () => {
    const scale = { min: 4, max: 18 };
    expect(weekBar(weekDay({ lowTemperatureC: 4, highTemperatureC: 9 }), scale)).toEqual({ left: 0, width: 100 / 14 * 5 });
    expect(weekBar(weekDay({ lowTemperatureC: null }), scale)).toBeNull();
    expect(weekBar(weekDay({ highTemperatureC: null }), scale)).toBeNull();
  });

  it('centres a single value on a flat scale instead of dividing by zero', () => {
    const scale = weekScale([weekDay({ lowTemperatureC: 7, highTemperatureC: 7 })]);
    expect(scale).toEqual({ min: 6, max: 8 });
    expect(scalePercent(7, scale)).toBe(50);
  });

  it('scales a rain bar against the wettest hour', () => {
    const hour = (rainMm: number | null): DayHour => ({ hour: 0, time: '', temperatureC: null, rainMm, windMs: null, windDirectionDeg: null, precipitationProbabilityPct: null, weatherCode: null });
    expect(rainBar(hour(0.5), 1)).toBe(50);
    expect(rainBar(hour(null), 1)).toBe(0);
    expect(rainBar(hour(0.5), 0)).toBe(0);
  });
});

describe('rain and model labels', () => {
  it('prefers the ECMWF rain chance, else the totals, else a gap', () => {
    expect(rainLabel(weekDay({ precipitationProbabilityPct: 63 }))).toBe('63%');
    expect(rainLabel(weekDay({ precipitationProbabilityPct: null, rainMm: 1.24 }))).toBe('1.2 mm');
    expect(rainLabel(weekDay({ precipitationProbabilityPct: null, rainMm: 0 }))).toBe('dry');
    expect(rainLabel(weekDay({ precipitationProbabilityPct: null, rainMm: null }))).toBe('—');
  });

  it('uses one rain unit for the whole week: chance only when every day has one', () => {
    const withChance = weekDay({ precipitationProbabilityPct: 63, rainMm: 1.24 });
    const withoutChance = weekDay({ day: '2026-10-16', precipitationProbabilityPct: null, rainMm: 0.2 });
    expect(weekRainMode([withChance])).toBe('chance');
    expect(weekRainMode([withChance, withoutChance])).toBe('amount');
    expect(weekRainMode([])).toBe('amount');
    expect(rainLabel(withChance, 'amount')).toBe('1.2 mm');
    expect(rainLabel(withChance, 'chance')).toBe('63%');
  });

  it('names today and folds single-model and partial days into one footnote', () => {
    expect(rowDayLabel('2026-10-15', '2026-10-15')).toBe('Today');
    expect(rowDayLabel('2026-10-16', '2026-10-15')).toBe('Fri');
    const today = weekDay({ partial: true });
    const last = weekDay({ day: '2026-10-21', models: 1, partial: true });
    // Today is always partial, so it is not called out; a later partial day is.
    expect(weekFootnote([today, last], '2026-10-15')).toBe('Faded bar: one model only · Wed: partial day');
    expect(weekFootnote([weekDay({})], '2026-10-15')).toBeNull();
  });

  it('labels a single-model day explicitly so it is never read as two', () => {
    expect(modelCountLabel(weekDay({ models: 1 }))).toBe('1 model');
    expect(modelCountLabel(weekDay({ models: 2 }))).toBe('2 models');
  });
});

describe('best run day', () => {
  it('picks the complete day with the least rain in its shared run window', () => {
    const dry = weekDay({ day: '2026-10-16', runWindow: runWindow({ day: '2026-10-16', rainMm: 0.1 }) });
    const wet = weekDay({ day: '2026-10-15', runWindow: runWindow({ rainMm: 1.4 }) });
    expect(bestRunDay([wet, dry])).toBe(dry);
  });

  it('falls back to a partial day only when no complete day has a window', () => {
    const partial = weekDay({ day: '2026-10-15', partial: true });
    expect(bestRunDay([partial])).toBe(partial);
    expect(bestRunDay([weekDay({ runWindow: null })])).toBeNull();
  });

  it('names the best day and the shared run window, and is empty when every day lacks one', () => {
    expect(bestRunSummary([weekDay({})])).toBe('Best day to run: Thu 15 Oct · 08:00-10:00 · 0.3 mm rain');
    expect(bestRunSummary([weekDay({ runWindow: runWindow({ rainMm: 0 }) })])).toBe('Best day to run: Thu 15 Oct · 08:00-10:00 · dry');
    expect(bestRunSummary([weekDay({ runWindow: null })])).toBeNull();
  });

  it('summarises a day run window for the meteogram, or says there is none', () => {
    expect(dayRunSummary(runWindow())).toBe('Best run 08:00-10:00 · 0.3 mm rain · 8-10° · wind 2-4 m/s');
    expect(dayRunSummary(null)).toBe('No two-hour run window this day');
  });
});

describe('day meteogram data', () => {
  const startIso = '2026-10-14T22:00:00Z';

  it('keeps only the chosen Copenhagen day and merges models with the first model winning', () => {
    const dmi = series('dmi_harmonie_arome_europe', startIso, 4, (index) => ({ temperatureC: 8 + index, rainMm: 0.1, precipitationProbabilityPct: null }));
    const ecmwf = series('ecmwf_ifs', startIso, 4, () => ({ temperatureC: 20, rainMm: 0.9, precipitationProbabilityPct: 55 }));
    const merged = dayHours([dmi, ecmwf], '2026-10-15');
    expect(merged.map((hour) => hour.hour)).toEqual([0, 1, 2, 3]);
    expect(merged.map((hour) => hour.temperatureC)).toEqual([8, 9, 10, 11]);
    expect(merged.map((hour) => hour.rainMm)).toEqual([0.1, 0.1, 0.1, 0.1]);
    // ECMWF is the only probability source, so its value survives where DMI is null.
    expect(merged[0]!.precipitationProbabilityPct).toBe(55);
    expect(modelDayHours(ecmwf, '2026-10-15')).toHaveLength(4);
    expect(modelDayHours(ecmwf, '2026-10-16')).toHaveLength(0);
  });

  it('leaves provider nulls as gaps and reports a null temperature scale as a centred flat scale', () => {
    const gap = series('ecmwf_ifs', startIso, 2, () => ({ temperatureC: null, rainMm: null }));
    const hours = modelDayHours(gap, '2026-10-15');
    expect(hours.map((hour) => hour.temperatureC)).toEqual([null, null]);
    expect(dayScale([hours])).toEqual({ min: 0, max: 1 });
    expect(rainSummary(hours)).toBe('Rain data unavailable');
  });

  it('summarises rain as a one-liner and shades exactly the run-window hours', () => {
    const hour = (n: number): DayHour => ({ hour: n, time: '', temperatureC: null, rainMm: null, windMs: null, windDirectionDeg: null, precipitationProbabilityPct: null, weatherCode: null });
    expect(rainSummary([{ ...hour(0), rainMm: 0 }, { ...hour(15), rainMm: 1 }])).toBe('Rain from 15:00');
    expect(rainSummary([{ ...hour(0), rainMm: 1 }, { ...hour(1), rainMm: 1 }])).toBe('Rain all day');
    expect(rainSummary([{ ...hour(0), rainMm: 0 }, { ...hour(1), rainMm: 0 }])).toBe('No rain through the day');
    expect(runWindowHours(runWindow())).toEqual([8, 9]);
    expect(runWindowHours(null)).toEqual([]);
  });
});

describe('weather code icon', () => {
  it('maps codes to a glyph and an accessible label, with a gap for null', () => {
    expect(weatherGlyph(0)).toBe('sun');
    expect(weatherGlyph(1)).toBe('part-cloud');
    expect(weatherGlyph(2)).toBe('part-cloud');
    expect(weatherGlyph(3)).toBe('cloud');
    expect(weatherGlyph(45)).toBe('fog');
    expect(weatherGlyph(48)).toBe('fog');
    expect(weatherGlyph(51)).toBe('drizzle');
    expect(weatherGlyph(57)).toBe('drizzle');
    expect(weatherGlyph(61)).toBe('rain');
    expect(weatherGlyph(67)).toBe('rain');
    expect(weatherGlyph(71)).toBe('snow');
    expect(weatherGlyph(77)).toBe('snow');
    expect(weatherGlyph(80)).toBe('rain');
    expect(weatherGlyph(82)).toBe('rain');
    expect(weatherGlyph(85)).toBe('snow');
    expect(weatherGlyph(86)).toBe('snow');
    expect(weatherGlyph(95)).toBe('storm');
    expect(weatherGlyph(null)).toBe('dot');
    expect(weatherCodeLabel(0)).toBe('Clear');
    expect(weatherCodeLabel(3)).toBe('Overcast');
    expect(weatherCodeLabel(null)).toBe('No forecast');
  });

  it('labels a Copenhagen date for the week row without shifting it by the device time zone', () => {
    expect(dayDateLabel('2026-10-15')).toBe('15 Oct');
    expect(dayDateLabel('2026-01-01')).toBe('1 Jan');
  });
});
