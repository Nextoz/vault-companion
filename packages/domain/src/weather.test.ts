import { describe, expect, it, vi } from 'vitest';
import {
  WEATHER_FALLBACK_LOCATION,
  WEATHER_MODEL_HOURS,
  WeatherProjection,
  type WeatherLocation,
  type WeatherModel,
  type WeatherModelSeries,
  type WeatherPoint,
} from '@vault-companion/contracts';
import {
  agreementFor,
  chooseRunWindow,
  createWeatherService,
  deviceWeatherLocation,
  normalizeWeatherLocation,
  weekDays,
  type WeatherModelOutcome,
  type WeatherModelReader,
} from './weather.ts';

const time = (hourUtc: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + hourUtc * 3_600_000).toISOString();
const point = (hourUtc: number, over: Record<string, unknown> = {}) => ({
  time: time(hourUtc), temperatureC: 15 + hourUtc * 0.2, rainMm: 0.5, windMs: 4,
  windDirectionDeg: 180, precipitationProbabilityPct: 40, weatherCode: 3, ...over,
});
const series = (
  model: WeatherModel,
  over: Record<string, unknown> = {},
  hourUtcStart = 6,
  hourUtcEnd = 10,
): WeatherModelSeries => ({
  model,
  label: model === 'dmi_harmonie_arome_europe' ? 'DMI HARMONIE AROME Europe' : 'ECMWF IFS 9 km',
  resolutionKm: model === 'dmi_harmonie_arome_europe' ? 2 : 9,
  sourceUrl: 'https://open-meteo.com/en/docs/dmi-api',
  retrievedAt: '2026-09-30T12:00:00Z',
  expectedPoints: WEATHER_MODEL_HOURS[model],
  points: Array.from({ length: hourUtcEnd - hourUtcStart + 1 }, (_, i) => point(hourUtcStart + i)),
  missingIntervals: 0,
  ...over,
});

const reader = (models: Record<WeatherModel, WeatherModelSeries | 'unavailable'>): WeatherModelReader => ({
  forecast: vi.fn(async (_location: WeatherLocation, model: WeatherModel): Promise<WeatherModelOutcome> =>
    models[model] === 'unavailable'
      ? { status: 'unavailable', reason: 'provider-error' }
      : { status: 'ok', series: models[model] as WeatherModelSeries, fresh: true }),
});

describe('weather location privacy (ADR-0033 W1)', () => {
  it('rounds before the reader is called, so no raw device coordinate reaches a provider or cache key', async () => {
    const seen: WeatherLocation[] = [];
    const service = createWeatherService({
      reader: { forecast: vi.fn(async (location: WeatherLocation): Promise<WeatherModelOutcome> => { seen.push(location); return { status: 'unavailable', reason: 'no-data' }; }) },
      now: () => new Date('2026-09-30T06:30:00Z'),
    });
    await service.readWeatherAtLocation({ latitude: 55.676123, longitude: 12.5639 });
    expect(seen[0]).toMatchObject({ latitude: 55.68, longitude: 12.56, precision: 'device-rounded' });
  });

  it('uses the public coarse Copenhagen fallback and keeps its label', () => {
    expect(normalizeWeatherLocation(WEATHER_FALLBACK_LOCATION)).toMatchObject({
      label: 'Copenhagen city centre (coarse fallback)', precision: 'city-fallback',
    });
    expect(deviceWeatherLocation({ latitude: 55.6761, longitude: 12.5639 }).label).toContain('rounded');
  });
});

describe('model agreement and daytime run window', () => {
  it('labels two overlapping valid models as two-model agreement, one as single-model, none as unavailable', () => {
    expect(agreementFor([series('dmi_harmonie_arome_europe'), series('ecmwf_ifs')])).toBe('two-models');
    expect(agreementFor([series('dmi_harmonie_arome_europe')])).toBe('single-model');
    expect(agreementFor([])).toBe('unavailable');
  });

  it('chooses the lowest-rain contiguous two-hour window inside Copenhagen 08:00-20:00 with actual model spread', () => {
    const dmi = series('dmi_harmonie_arome_europe', {
      points: [
        point(6, { rainMm: 0.1, temperatureC: 14, windMs: 3 }),
        point(7, { rainMm: 0.2, temperatureC: 15, windMs: 4 }),
        point(8, { rainMm: 2, temperatureC: 16, windMs: 5 }),
        point(9, { rainMm: 2, temperatureC: 17, windMs: 6 }),
      ],
    });
    const ecmwf = series('ecmwf_ifs', {
      points: [
        point(6, { rainMm: 0.3, temperatureC: 13, windMs: 5 }),
        point(7, { rainMm: 0.4, temperatureC: 14, windMs: 6 }),
        point(8, { rainMm: 3, temperatureC: 15, windMs: 7 }),
        point(9, { rainMm: 3, temperatureC: 16, windMs: 8 }),
      ],
    });
    const window = chooseRunWindow([dmi, ecmwf], '2026-09-30', 'Europe/Copenhagen');
    expect(window).toMatchObject({
      day: '2026-09-30', daytimeStart: '08:00', daytimeEnd: '20:00',
      start: time(6), end: time(8), agreement: 'two-models',
      models: ['dmi_harmonie_arome_europe', 'ecmwf_ifs'],
      rainMm: 0.3, rainRangeMm: { min: 0.3, max: 0.7 },
      temperatureRangeC: { min: 13, max: 15 }, windRangeMs: { min: 3, max: 6 },
    });
  });

  it('does not bridge a missing hourly bucket and never claims a window outside 08:00-20:00', () => {
    const single = series('dmi_harmonie_arome_europe', { points: [point(6, { rainMm: 0.2 }), point(8, { rainMm: 0.1 })] });
    expect(chooseRunWindow([single], '2026-09-30', 'Europe/Copenhagen')).toBeNull();
    const earlyOnly = series('dmi_harmonie_arome_europe', { points: [point(4), point(5)] });
    expect(chooseRunWindow([earlyOnly], '2026-09-30', 'Europe/Copenhagen')).toBeNull();
  });
});

describe('createWeatherService', () => {
  it('requests only the two fixed models and returns the shared projection', async () => {
    const dmi = series('dmi_harmonie_arome_europe');
    const ecmwf = series('ecmwf_ifs');
    const forecast = reader({ dmi_harmonie_arome_europe: dmi, ecmwf_ifs: ecmwf });
    const service = createWeatherService({ reader: forecast, now: () => new Date('2026-09-30T06:30:00Z') });
    const response = await service.readWeather();
    expect(response.status).toBe('ok');
    if (response.status !== 'ok') return;
    expect(forecast.forecast).toHaveBeenNthCalledWith(1, expect.anything(), 'dmi_harmonie_arome_europe');
    expect(forecast.forecast).toHaveBeenNthCalledWith(2, expect.anything(), 'ecmwf_ifs');
    expect(response.projection.agreement).toBe('two-models');
    expect(response.projection.partialError).toBe('none');
    expect(response.projection.runWindow).not.toBeNull();
  });

  it('serves one model honestly as single-model when the other fails', async () => {
    const service = createWeatherService({
      reader: reader({ dmi_harmonie_arome_europe: series('dmi_harmonie_arome_europe'), ecmwf_ifs: 'unavailable' }),
      now: () => new Date('2026-09-30T06:30:00Z'),
    });
    const response = await service.readWeather();
    if (response.status !== 'ok') throw new Error('expected one usable model');
    expect(response.projection.models.map((m) => m.model)).toEqual(['dmi_harmonie_arome_europe']);
    expect(response.projection.agreement).toBe('single-model');
    expect(response.projection.partialError).toBe('one-model-unavailable');
  });

  it('answers unavailable when no model has usable points', async () => {
    const service = createWeatherService({
      reader: reader({ dmi_harmonie_arome_europe: 'unavailable', ecmwf_ifs: 'unavailable' }),
      now: () => new Date('2026-09-30T06:30:00Z'),
    });
    await expect(service.readWeather()).resolves.toMatchObject({ status: 'unavailable', reason: 'provider-error' });
  });
});

const DAY0_MS = Date.parse('2026-10-10T00:00:00+02:00');
const at = (ms: number): string => new Date(ms).toISOString();

const seriesOf = (
  model: WeatherModel,
  hours: number,
  startMs: number,
  shape: (index: number) => Record<string, unknown> = () => ({}),
): WeatherModelSeries => ({
  model,
  label: model === 'dmi_harmonie_arome_europe' ? 'DMI HARMONIE AROME Europe' : 'ECMWF IFS 9 km',
  resolutionKm: model === 'dmi_harmonie_arome_europe' ? 2 : 9,
  sourceUrl: 'https://open-meteo.com/en/docs',
  retrievedAt: '2026-10-10T00:00:00Z',
  expectedPoints: WEATHER_MODEL_HOURS[model],
  points: Array.from({ length: hours }, (_, index) => ({
    time: at(startMs + index * 3_600_000), temperatureC: 10, rainMm: 0, windMs: 2,
    windDirectionDeg: 180, precipitationProbabilityPct: 20, weatherCode: 1, ...shape(index),
  }) as WeatherPoint),
  missingIntervals: 0,
});

const projectionOf = (models: readonly WeatherModelSeries[]): WeatherProjection => WeatherProjection.parse({
  location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
  now: '2026-10-10T06:00:00Z',
  models,
  agreement: models.length >= 2 ? 'two-models' : 'single-model',
  coverage: { expectedPoints: WEATHER_MODEL_HOURS[models[0]!.model], primaryReturned: models[0]!.points.length, comparisonReturned: models[1]?.points.length ?? 0, primaryMissingIntervals: 0, comparisonMissingIntervals: 0 },
  runWindow: null,
  partialError: 'none',
  attribution: 'Synthetic forecast.',
  termsUrl: 'https://example.test/terms',
});

describe('weekDays (ADR-0033 W1, week overview)', () => {
  it('returns one entry per Copenhagen local day from a 7-day two-source fixture and merges both models', () => {
    const ecmwf = seriesOf('ecmwf_ifs', 168, DAY0_MS, (index) => ({
      temperatureC: 6 + (index % 10),
      rainMm: index % 24 === 3 ? 0.5 : 0,
      precipitationProbabilityPct: index % 24,
      weatherCode: index % 24 === 14 ? 61 : 3,
    }));
    const dmi = seriesOf('dmi_harmonie_arome_europe', 72, DAY0_MS, () => ({ temperatureC: 4, precipitationProbabilityPct: null, weatherCode: 2 }));
    const days = weekDays(projectionOf([dmi, ecmwf]));
    expect(days.map((day) => day.day)).toEqual(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
    expect(days.every((day) => day.partial === false)).toBe(true);
    // Days beyond the DMI horizon carry a single model; the first three carry both.
    expect(days.map((day) => day.models)).toEqual([2, 2, 2, 1, 1, 1, 1]);
    expect(days.every((day) => day.runWindow?.day === day.day)).toBe(true);
    // DMI wins the hour it covers: its temperature and WMO code, while ECMWF is the only precipitation probability source.
    expect(days[0]).toMatchObject({ lowTemperatureC: 4, highTemperatureC: 4, weatherCode: 2 });
    expect(days[0]!.precipitationProbabilityPct).toBe(23);
    expect(days[6]!.models).toBe(1);
  });

  it('ignores a non-ECMWF precipitation probability: a DMI-only day reports null', () => {
    const dmi = seriesOf('dmi_harmonie_arome_europe', 72, DAY0_MS, () => ({ precipitationProbabilityPct: 55 }));
    const days = weekDays(projectionOf([dmi]));
    expect(days).toHaveLength(3);
    expect(days.every((day) => day.models === 1 && day.precipitationProbabilityPct === null)).toBe(true);
  });

  it('keeps provider nulls as gaps and makes the daily rain total null (partial) when any hour is unknown', () => {
    const withGap = seriesOf('ecmwf_ifs', 24, DAY0_MS, (index) => (index === 3 ? { temperatureC: null, rainMm: null, weatherCode: null } : {}));
    const days = weekDays(projectionOf([withGap]));
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: '2026-10-10', partial: true, lowTemperatureC: 10, highTemperatureC: 10, rainMm: null });
  });

  it('buckets days by Copenhagen local time across a DST change', () => {
    const start = Date.parse('2026-03-28T00:00:00+01:00'); // CET; spring-forward is 2026-03-29
    const days = weekDays(projectionOf([seriesOf('ecmwf_ifs', 48, start, () => ({ temperatureC: 8 }))]));
    expect(days.map((day) => day.day)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    // The 23-hour spring-forward day is still a full day; the one-hour tail is partial.
    expect(days.map((day) => day.partial)).toEqual([false, false, true]);
  });
});

describe('createWeatherService with the longer series', () => {
  it('keeps the 168-hour ECMWF series and reports one-model-unavailable when DMI fails', async () => {
    const ecmwf = seriesOf('ecmwf_ifs', 168, DAY0_MS, () => ({ temperatureC: 7 }));
    const service = createWeatherService({
      reader: reader({ dmi_harmonie_arome_europe: 'unavailable', ecmwf_ifs: ecmwf }),
      now: () => new Date('2026-10-10T06:30:00Z'),
    });
    const response = await service.readWeather();
    if (response.status !== 'ok') throw new Error('expected the ECMWF series');
    expect(response.projection.models.map((series) => series.model)).toEqual(['ecmwf_ifs']);
    expect(response.projection.models[0]!.points).toHaveLength(168);
    expect(response.projection.partialError).toBe('one-model-unavailable');
    expect(response.projection.coverage.expectedPoints).toBe(168);
  });
});
