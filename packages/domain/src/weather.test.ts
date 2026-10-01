import { describe, expect, it, vi } from 'vitest';
import {
  WEATHER_FALLBACK_LOCATION,
  WEATHER_FORECAST_HOURS,
  type WeatherLocation,
  type WeatherModel,
  type WeatherModelSeries,
} from '@vault-companion/contracts';
import {
  agreementFor,
  chooseRunWindow,
  createWeatherService,
  deviceWeatherLocation,
  normalizeWeatherLocation,
  type WeatherModelOutcome,
  type WeatherModelReader,
} from './weather.ts';

const time = (hourUtc: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + hourUtc * 3_600_000).toISOString();
const point = (hourUtc: number, over: Record<string, unknown> = {}) => ({
  time: time(hourUtc), temperatureC: 15 + hourUtc * 0.2, rainMm: 0.5, windMs: 4, ...over,
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
  expectedPoints: WEATHER_FORECAST_HOURS,
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
