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

const raw = (over: Record<string, unknown> = {}): unknown => ({
  utc_offset_seconds: 0,
  hourly_units: { time: 'unixtime', temperature_2m: '°C', rain: 'mm', wind_speed_10m: 'm/s' },
  hourly: {
    time: [START_SEC, START_SEC + 3600],
    temperature_2m: [15.2, 16.1],
    rain: [0, 0.4],
    wind_speed_10m: [4.1, 5.2],
  },
  ...over,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('weatherUrl (fixed endpoints/models only)', () => {
  it('uses the DMI selector on the forecast endpoint and ECMWF on its comparison endpoint', () => {
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('https://api.open-meteo.com/v1/forecast');
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('models=dmi_harmonie_arome_europe');
    expect(weatherUrl(LOCATION, 'ecmwf_ifs')).toContain('https://api.open-meteo.com/v1/ecmwf');
    expect(weatherUrl(LOCATION, 'ecmwf_ifs')).toContain('models=ecmwf_ifs');
    expect(weatherUrl(LOCATION, 'dmi_harmonie_arome_europe')).toContain('wind_speed_unit=ms&timeformat=unixtime&timezone=GMT');
  });
});

describe('parseWeatherBody (strict provider validation)', () => {
  it('refuses a unix instant outside the JavaScript date range without throwing', () => {
    expect(parseWeatherBody(raw({ hourly: { time: [Number.MAX_SAFE_INTEGER], temperature_2m: [15], rain: [0], wind_speed_10m: [4] } }), 'dmi_harmonie_arome_europe', NOW_ISO)).toBeNull();
  });
  it('accepts the verified unixtime/°C/mm/m/s shape and keeps null values as gaps', () => {
    const parsed = parseWeatherBody(raw({ hourly: { time: [START_SEC, START_SEC + 3600], temperature_2m: [15.2, null], rain: [null, 0.4], wind_speed_10m: [4.1, 5.2] } }), 'dmi_harmonie_arome_europe', NOW_ISO);
    expect(parsed).not.toBeNull();
    expect(parsed!.points[0]).toMatchObject({ temperatureC: 15.2, rainMm: null, windMs: 4.1 });
    expect(parsed!.points[1]).toMatchObject({ temperatureC: null, rainMm: 0.4, windMs: 5.2 });
  });

  it.each([
    ['wrong offset', { utc_offset_seconds: 7200 }],
    ['wrong time unit', { hourly_units: { time: 'unixtime', temperature_2m: '°C', rain: 'mm', wind_speed_10m: 'km/h' } }],
    ['non-finite value', { hourly: { time: [START_SEC], temperature_2m: [NaN], rain: [0], wind_speed_10m: [4] } }],
    ['negative rain', { hourly: { time: [START_SEC], temperature_2m: [15], rain: [-0.1], wind_speed_10m: [4] } }],
    ['out-of-order time', { hourly: { time: [START_SEC + 3600, START_SEC], temperature_2m: [15, 16], rain: [0, 0], wind_speed_10m: [4, 5] } }],
    ['more than 48 points', { hourly: { time: Array.from({ length: 49 }, (_, i) => START_SEC + i * 3600), temperature_2m: Array.from({ length: 49 }, () => 15), rain: Array.from({ length: 49 }, () => 0), wind_speed_10m: Array.from({ length: 49 }, () => 4) } }],
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
