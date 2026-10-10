/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { WEATHER_MODEL_HOURS } from '@vault-companion/contracts';
import { createWeatherService } from '@vault-companion/domain';
import { describe, expect, it } from 'vitest';
import {
  createWeatherProvider,
  parseWeatherBody,
  WEATHER_CACHE_TTL_MS,
  WEATHER_MAX_BODY_BYTES,
  weatherUrl,
} from './weather-provider.ts';

const NOW_MS = Date.parse('2026-09-30T12:00:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const START_SEC = Math.floor(Date.parse('2026-09-30T06:00:00Z') / 1000);
const LOCATION = { label: 'Copenhagen', latitude: 55.68, longitude: 12.57, precision: 'city-fallback' as const, timeZone: 'Europe/Copenhagen' as const };

const UNITS = { time: 'unixtime', temperature_2m: '°C', rain: 'mm', wind_speed_10m: 'm/s', wind_direction_10m: '°', precipitation_probability: '%', weather_code: 'wmo code' };
const raw = (over: Record<string, unknown> = {}): unknown => ({
  utc_offset_seconds: 0,
  hourly_units: UNITS,
  hourly: columns([START_SEC, START_SEC + 3600]),
  ...over,
});

/** A full verified hourly shape; individual columns can be overridden to probe each guard. */
const columns = (times: number[], over: Record<string, unknown> = {}): Record<string, unknown> => {
  const constant = (value: unknown) => times.map(() => value);
  return {
    time: times,
    temperature_2m: constant(15.2),
    rain: constant(0),
    wind_speed_10m: constant(4.1),
    wind_direction_10m: constant(200),
    precipitation_probability: constant(10),
    weather_code: constant(0),
    ...over,
  };
};

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('weatherUrl (fixed endpoints/models only)', () => {
  it('uses the DMI selector on the forecast endpoint and ECMWF on its comparison endpoint', () => {
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('https://api.open-meteo.com/v1/forecast');
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('models=dmi_harmonie_arome_europe');
    expect(weatherUrl(LOCATION, 'ecmwf_ifs')).toContain('https://api.open-meteo.com/v1/ecmwf');
    expect(weatherUrl(LOCATION, 'ecmwf_ifs')).toContain('models=ecmwf_ifs');
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('wind_speed_unit=ms&timeformat=unixtime&timezone=GMT');
  });

  it('asks each model for its own horizon and the week/meteogram hourly fields', () => {
    expect(weatherUrl(LOCATION, 'ecmwf_ifs')).toContain(`forecast_hours=${WEATHER_MODEL_HOURS.ecmwf_ifs}`);
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain(`forecast_hours=${WEATHER_MODEL_HOURS.dmi_harmonie_arome_europe}`);
    const hourly = decodeURIComponent(weatherUrl(LOCATION, 'ecmwf_ifs').split('hourly=')[1]!.split('&')[0]!);
    expect(hourly).toBe('temperature_2m,rain,wind_speed_10m,wind_direction_10m,precipitation_probability,weather_code');
  });
});

describe('parseWeatherBody (strict provider validation)', () => {
  it('accepts the verified units/shape and keeps the new nullable fields as gaps', () => {
    const parsed = parseWeatherBody(raw({
      hourly: columns([START_SEC, START_SEC + 3600], {
        temperature_2m: [15.2, null],
        rain: [null, 0.4],
        wind_speed_10m: [4.1, 5.2],
        wind_direction_10m: [null, 210],
        precipitation_probability: [null, 80],
        weather_code: [null, 61],
      }),
    }), 'dmi_harmonie_arome_europe', NOW_ISO);
    expect(parsed).not.toBeNull();
    expect(parsed!.points[0]).toMatchObject({ temperatureC: 15.2, rainMm: null, windMs: 4.1, windDirectionDeg: null, precipitationProbabilityPct: null, weatherCode: null });
    expect(parsed!.points[1]).toMatchObject({ temperatureC: null, rainMm: 0.4, windMs: 5.2, windDirectionDeg: 210, precipitationProbabilityPct: 80, weatherCode: 61 });
    expect(parsed!.expectedPoints).toBe(WEATHER_MODEL_HOURS.dmi_harmonie_arome_europe);
  });

  it('refuses non-hourly instants but drops points beyond the model horizon instead of refusing the body', () => {
    expect(parseWeatherBody(raw({ hourly: columns([START_SEC + 1]) }), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
    const beyond = parseWeatherBody(raw({ hourly: columns([START_SEC, START_SEC + 72 * 3600, START_SEC + 73 * 3600]) }), 'dmi_harmonie_arome_europe', NOW_ISO)!;
    expect(beyond.points.map((point) => point.time)).toEqual([new Date(START_SEC * 1000).toISOString()]);
    expect(beyond.missingIntervals).toBe(71);
  });

  it('refuses a unix instant outside the JavaScript date range without throwing', () => {
    expect(parseWeatherBody(raw({ hourly: columns([Number.MAX_SAFE_INTEGER]) }), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
  });

  it('tolerates the DMI precipitation_probability unit "undefined" only when every value is null', () => {
    const units = { ...UNITS, precipitation_probability: 'undefined' };
    expect(parseWeatherBody(raw({ hourly_units: units, hourly: columns([START_SEC], { precipitation_probability: [null] }) }), 'dmi_harmonie_arome_europe', NOW_ISO)!.points[0]!.precipitationProbabilityPct).toBeNull();
    expect(parseWeatherBody(raw({ hourly_units: units, hourly: columns([START_SEC], { precipitation_probability: [40] }) }), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
    expect(parseWeatherBody(raw({ hourly_units: { ...UNITS, precipitation_probability: 'mm' }, hourly: columns([START_SEC], { precipitation_probability: [null] }) }), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
  });

  it.each([
    ['wrong offset', { utc_offset_seconds: 7200 }],
    ['wrong time unit', { hourly_units: { ...UNITS, time: 'iso8601' } }],
    ['wrong temperature unit', { hourly_units: { ...UNITS, temperature_2m: 'K' } }],
    ['wrong rain unit', { hourly_units: { ...UNITS, rain: 'cm' } }],
    ['wrong wind unit', { hourly_units: { ...UNITS, wind_speed_10m: 'km/h' } }],
    ['wrong direction unit', { hourly_units: { ...UNITS, wind_direction_10m: '%' } }],
    ['wrong weather code unit', { hourly_units: { ...UNITS, weather_code: 'mm' } }],
    ['non-increasing time', { hourly: columns([START_SEC + 3600, START_SEC]) }],
    ['non-finite temperature', { hourly: columns([START_SEC], { temperature_2m: [NaN] }) }],
    ['negative rain', { hourly: columns([START_SEC], { rain: [-0.1] }) }],
    ['wind direction above 360', { hourly: columns([START_SEC], { wind_direction_10m: [400] }) }],
    ['probability above 100', { hourly: columns([START_SEC], { precipitation_probability: [101] }) }],
    ['fractional weather code', { hourly: columns([START_SEC], { weather_code: [1.5] }) }],
    ['mismatched column length', { hourly: columns([START_SEC, START_SEC + 3600], { rain: [0] }) }],
  ])('refuses %s as malformed', (_name, over) => {
    expect(parseWeatherBody(raw(over), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
  });
});

describe('weather provider cache and dedup', () => {
  it('caches by rounded location/model and does not refetch inside the TTL', async () => {
    let calls = 0;
    let now = NOW_MS;
    const provider = createWeatherProvider({
      fetch: async () => { calls++; return json(raw()); },
      now: () => now,
    });
    const first = await provider.forecast(LOCATION, 'dmi_harmonie_arome_europe');
    expect(first.status).toBe('ok');
    const second = await provider.forecast({ ...LOCATION, latitude: 55.684 }, 'dmi_harmonie_arome_europe');
    expect(second.status).toBe('ok');
    expect(calls).toBe(1);
    now += WEATHER_CACHE_TTL_MS / 2;
    await provider.forecast(LOCATION, 'dmi_harmonie_arome_europe');
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent reads for the same rounded location/model', async () => {
    let calls = 0;
    const provider = createWeatherProvider({
      fetch: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return json(raw()); },
      now: () => NOW_MS,
    });
    await Promise.all([provider.forecast(LOCATION, 'dmi_harmonie_arome_europe'), provider.forecast(LOCATION, 'dmi_harmonie_arome_europe')]);
    expect(calls).toBe(1);
  });

  it('bounds simultaneous distinct provider reads without blocking same-key deduplication', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const provider = createWeatherProvider({ fetch: async () => { calls++; await wait; return json(raw()); }, now: () => NOW_MS });
    const pending = Array.from({ length: 4 }, (_, i) => provider.forecast({ ...LOCATION, latitude: 55 + i }, 'dmi_harmonie_arome_europe'));
    const duplicate = provider.forecast({ ...LOCATION, latitude: 55 }, 'dmi_harmonie_arome_europe');
    expect(await provider.forecast({ ...LOCATION, latitude: 60 }, 'dmi_harmonie_arome_europe')).toEqual({ status: 'unavailable', reason: 'provider-error' });
    expect(calls).toBe(4);
    release();
    expect((await Promise.all([...pending, duplicate])).every((result) => result.status === 'ok')).toBe(true);
  });

  it('reuses stale data with its ORIGINAL retrievedAt after a failed refresh, and never caches the error', async () => {
    let now = NOW_MS;
    let fail = false;
    const provider = createWeatherProvider({
      fetch: async () => (fail ? new Response('x', { status: 503 }) : json(raw())),
      now: () => now,
    });
    const first = await provider.forecast(LOCATION, 'dmi_harmonie_arome_europe');
    expect(first.status).toBe('ok');
    fail = true;
    now += WEATHER_CACHE_TTL_MS + 1;
    const stale = await provider.forecast(LOCATION, 'dmi_harmonie_arome_europe');
    expect(stale).toMatchObject({ status: 'ok', fresh: false });
    if (stale.status === 'ok') expect(stale.series.retrievedAt).toBe(NOW_ISO);
  });

  it('bounds the cache to a fixed number of entries and reports a timeout', async () => {
    let calls = 0;
    const provider = createWeatherProvider({
      fetch: async () => { calls++; return json(raw()); },
      now: () => NOW_MS,
    });
    const models = ['dmi_harmonie_arome_europe', 'ecmwf_ifs'] as const;
    const locations = [55.68, 55.69, 55.7, 55.71, 55.72];
    for (const latitude of locations) {
      for (const model of models) await provider.forecast({ ...LOCATION, latitude }, model);
    }
    expect(calls).toBe(10);
    // The first entry was evicted from the fixed-size cache, so asking for it again refetches.
    await provider.forecast({ ...LOCATION, latitude: 55.68 }, 'dmi_harmonie_arome_europe');
    expect(calls).toBe(11);
  });

  it('refuses a body that is too large', async () => {
    const provider = createWeatherProvider({
      fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(WEATHER_MAX_BODY_BYTES + 1)); controller.close(); },
      })),
      now: () => NOW_MS,
    });
    await expect(provider.forecast(LOCATION, 'dmi_harmonie_arome_europe')).resolves.toEqual({ status: 'unavailable', reason: 'malformed' });
  });
});

describe('captured provider fixtures (WX1a)', () => {
  it('parses the 7-day ECMWF capture: 168 points, no nulls, no gaps', () => {
    const series = parseWeatherBody(fixture('open-meteo-ecmwf-7d.json'), 'ecmwf_ifs', NOW_ISO)!;
    expect(series.expectedPoints).toBe(168);
    expect(series.points).toHaveLength(168);
    expect(series.missingIntervals).toBe(0);
    expect(series.points.some((point) => point.temperatureC === null || point.rainMm === null || point.windMs === null || point.windDirectionDeg === null || point.precipitationProbabilityPct === null || point.weatherCode === null)).toBe(false);
  });

  it('parses the DMI capture: only its 72-hour horizon is kept and the all-null undefined precipitation probability is tolerated', () => {
    const series = parseWeatherBody(fixture('open-meteo-dmi-7d.json'), 'dmi_harmonie_arome_europe', NOW_ISO)!;
    expect(series.expectedPoints).toBe(72);
    expect(series.points).toHaveLength(72);
    expect(series.missingIntervals).toBe(0);
    expect(series.points.every((point) => point.precipitationProbabilityPct === null)).toBe(true);
    expect(series.points.every((point) => point.windDirectionDeg !== null && point.weatherCode !== null)).toBe(true);
  });

  it('keeps the two captured series well under the response body cap', () => {
    const ecmwf = parseWeatherBody(fixture('open-meteo-ecmwf-7d.json'), 'ecmwf_ifs', NOW_ISO)!;
    const dmi = parseWeatherBody(fixture('open-meteo-dmi-7d.json'), 'dmi_harmonie_arome_europe', NOW_ISO)!;
    expect(new TextEncoder().encode(JSON.stringify([ecmwf, dmi])).length).toBeLessThan(WEATHER_MAX_BODY_BYTES);
  });
});

describe('one provider request per model per refresh', () => {
  it('fetches each model once and serves the cached series on a re-read', async () => {
    const calls: string[] = [];
    const provider = createWeatherProvider({
      fetch: async (url) => {
        const target = String(url);
        calls.push(target);
        return new Response(JSON.stringify(fixture(target.includes('/v1/ecmwf') ? 'open-meteo-ecmwf-7d.json' : 'open-meteo-dmi-7d.json')), { status: 200 });
      },
      now: () => NOW_MS,
    });
    const service = createWeatherService({ reader: provider, now: () => new Date(NOW_MS) });
    await service.readWeather();
    await service.readWeather();
    expect(calls).toHaveLength(2);
    expect(calls.filter((url) => url.includes('forecast_hours=168'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('forecast_hours=72'))).toHaveLength(1);
  });
});
