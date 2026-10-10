import { describe, expect, it } from 'vitest';
import {
  roundWeatherCoordinate,
  WEATHER_FALLBACK_LOCATION,
  WEATHER_MODEL_HOURS,
  WeatherProjection,
  WeatherResponse,
} from './weather.ts';

const time = (hour: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + hour * 3_600_000).toISOString();
const point = (hour: number, over: Record<string, unknown> = {}) => ({
  time: time(hour), temperatureC: 15 + hour * 0.1, rainMm: hour % 4 === 0 ? 0.2 : null, windMs: 4.2,
  windDirectionDeg: 180, precipitationProbabilityPct: 40, weatherCode: 3, ...over,
});
const series = (model: 'dmi_harmonie_arome_europe' | 'ecmwf_ifs', over: Record<string, unknown> = {}) => ({
  model,
  label: model === 'dmi_harmonie_arome_europe' ? 'DMI HARMONIE AROME Europe' : 'ECMWF IFS 9 km',
  resolutionKm: model === 'dmi_harmonie_arome_europe' ? 2 : 9,
  sourceUrl: 'https://open-meteo.com/en/docs/dmi-api',
  retrievedAt: '2026-09-30T12:00:00Z',
  expectedPoints: WEATHER_MODEL_HOURS[model],
  points: Array.from({ length: 8 }, (_, i) => point(i)),
  missingIntervals: 0,
  ...over,
});

const projection = (over: Record<string, unknown> = {}) => ({
  location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
  now: '2026-09-30T12:00:00Z',
  models: [series('dmi_harmonie_arome_europe'), series('ecmwf_ifs')],
  agreement: 'two-models',
  coverage: { expectedPoints: 72, primaryReturned: 8, comparisonReturned: 8, primaryMissingIntervals: 0, comparisonMissingIntervals: 0 },
  runWindow: {
    day: '2026-09-30', daytimeStart: '08:00', daytimeEnd: '20:00',
    start: '2026-09-30T08:00:00Z', end: '2026-09-30T10:00:00Z',
    agreement: 'two-models', models: ['dmi_harmonie_arome_europe', 'ecmwf_ifs'], rainMm: 0.4,
    rainRangeMm: { min: 0.4, max: 0.8 }, temperatureRangeC: { min: 15, max: 18 }, windRangeMs: { min: 4, max: 6 },
    note: 'Lowest-rain daytime window; not a guarantee of dry weather.',
  },
  partialError: 'none',
  attribution: 'Forecast data by DMI and ECMWF via Open-Meteo, CC-BY 4.0.',
  termsUrl: 'https://open-meteo.com/en/terms',
  ...over,
});

describe('weather contract (ADR-0033 W1)', () => {
  it('accepts the canonical shared projection and the /api/weather response', () => {
    const parsed = WeatherResponse.parse({ status: 'ok', projection: projection() });
    expect(parsed.status).toBe('ok');
    expect(WeatherProjection.parse(projection()).runWindow).not.toBeNull();
  });

  it('keeps provider nulls as gaps and refuses invented non-finite or negative values', () => {
    const withNull = projection({ models: [series('dmi_harmonie_arome_europe', { points: [point(0), { ...point(1), rainMm: null, temperatureC: null, windMs: null }] })] });
    expect(WeatherProjection.parse(withNull).models[0]!.points[1]).toMatchObject({ rainMm: null });

    expect(WeatherProjection.safeParse(projection({ models: [series('dmi_harmonie_arome_europe', { points: [{ ...point(0), temperatureC: Number.NaN }] })] })).success).toBe(false);
    expect(WeatherProjection.safeParse(projection({ models: [series('dmi_harmonie_arome_europe', { points: [{ ...point(0), rainMm: -0.1 }] })] })).success).toBe(false);
  });

  it('caps each series at its own horizon (DMI 72, ECMWF 168) and rejects an unknown model', () => {
    const dmiFull = series('dmi_harmonie_arome_europe', { points: Array.from({ length: 72 }, (_, i) => point(i)) });
    expect(WeatherProjection.safeParse(projection({ models: [dmiFull] })).success).toBe(true);
    const dmiTooMany = series('dmi_harmonie_arome_europe', { points: Array.from({ length: 73 }, (_, i) => point(i)) });
    expect(WeatherProjection.safeParse(projection({ models: [dmiTooMany] })).success).toBe(false);
    const ecmwfTooMany = series('ecmwf_ifs', { points: Array.from({ length: 169 }, (_, i) => point(i)) });
    expect(WeatherProjection.safeParse(projection({ models: [ecmwfTooMany] })).success).toBe(false);
    expect(WeatherProjection.safeParse(projection({ models: [{ ...series('dmi_harmonie_arome_europe'), model: 'generic' }] })).success).toBe(false);
  });

  it('accepts nullable wind direction, precipitation probability and weather code, and refuses out-of-range values', () => {
    const withExtras = series('ecmwf_ifs', {
      points: [
        point(0, { windDirectionDeg: 210, precipitationProbabilityPct: 80, weatherCode: 61 }),
        point(1, { windDirectionDeg: null, precipitationProbabilityPct: null, weatherCode: null }),
      ],
    });
    const parsed = WeatherProjection.parse(projection({ models: [withExtras] }));
    expect(parsed.models[0]!.points[0]).toMatchObject({ windDirectionDeg: 210, precipitationProbabilityPct: 80, weatherCode: 61 });
    expect(parsed.models[0]!.points[1]).toMatchObject({ windDirectionDeg: null, precipitationProbabilityPct: null, weatherCode: null });
    const outOfRange = (over: Record<string, unknown>) => series('ecmwf_ifs', { points: [point(0, over)] });
    for (const over of [{ windDirectionDeg: 361 }, { precipitationProbabilityPct: 101 }, { weatherCode: 1.5 }]) {
      expect(WeatherProjection.safeParse(projection({ models: [outOfRange(over)] })).success).toBe(false);
    }
  });

  it('rounds coordinates to the fixed ~1 km grid before they can be sent or cached', () => {
    expect(roundWeatherCoordinate(55.676123)).toBe(55.68);
    expect(roundWeatherCoordinate(12.5639)).toBe(12.56);
    expect(roundWeatherCoordinate(-1.2345)).toBe(-1.23);
  });

  it('fixes Copenhagen as the timezone and labels the fallback as a public coarse city', () => {
    expect(WEATHER_FALLBACK_LOCATION.timeZone).toBe('Europe/Copenhagen');
    expect(WEATHER_FALLBACK_LOCATION.precision).toBe('city-fallback');
    expect(WEATHER_FALLBACK_LOCATION.label).toContain('Copenhagen city centre');
  });
});
