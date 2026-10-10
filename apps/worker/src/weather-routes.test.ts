/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { WeatherResponse, type WeatherLocationRequest } from '@vault-companion/contracts';
import { createWeatherService } from '@vault-companion/domain';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import { createWeatherProvider, WEATHER_MAX_BODY_BYTES } from './weather-provider.ts';

const ORIGIN = 'https://vc.example.com';
const ACCOUNT = 'a'.repeat(64);

const services = (over: Partial<Services> = {}): Services => ({
  async readTasks() { return { code: 'upstream-unavailable', message: 'x', retryable: true }; },
  async execute() { return { code: 'invalid', message: 'x', retryable: false }; },
  ...over,
});

const app = (over: Partial<Services> = {}) =>
  createApp({
    verify: async (token) => (token === 'good' ? { ok: true, email: 'owner@example.com', accountKey: ACCOUNT } : { ok: false }),
    appOrigin: ORIGIN,
    services: services(over),
    log: () => {},
  });

const unavailable = WeatherResponse.parse({ status: 'unavailable', now: '2026-09-30T12:00:00Z', location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' }, reason: 'provider-error', message: 'No weather.' });

describe('weather routes are authenticated and guarded (ADR-0033 W1)', () => {
  it('GET /api/weather requires an Access token', async () => {
    const res = await app().request('/api/weather', { headers: { 'Cf-Access-Jwt-Assertion': 'bad' } });
    expect(res.status).toBe(401);
  });

  it('GET /api/weather answers 404 when the service is not composed, without provider input', async () => {
    const res = await app().request('/api/weather', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(404);
  });

  it('POST /api/weather/location inherits the origin/account guards and never reaches the service on a mismatch', async () => {
    const read = vi.fn(async () => unavailable);
    const post = (headers: Record<string, string>) => app({ readWeatherAtLocation: read }).request('/api/weather/location', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'good', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ latitude: 55.6761, longitude: 12.5639 }),
    });
    await expect(post({ Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': 'b'.repeat(64) })).resolves.toMatchObject({ status: 409 });
    await expect(post({ Origin: 'https://evil.example.com', 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT })).resolves.toMatchObject({ status: 403 });
    expect(read).not.toHaveBeenCalled();
  });

  it('POST parses only latitude/longitude and passes the device coordinates to the service', async () => {
    const read = vi.fn(async (_request: WeatherLocationRequest) => unavailable);
    const res = await app({ readWeatherAtLocation: read }).request('/api/weather/location', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'good', Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 55.6761, longitude: 12.5639 }),
    });
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith({ latitude: 55.6761, longitude: 12.5639 });
    const bad = await app({ readWeatherAtLocation: read }).request('/api/weather/location', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': 'good', Origin: ORIGIN, 'X-VC-Request': '1', 'X-VC-Account': ACCOUNT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: 91, longitude: 12 }),
    });
    expect(bad.status).toBe(400);
  });

  it('serves the default GET through the composed read service', async () => {
    const read = vi.fn(async () => unavailable);
    const res = await app({ readWeather: read }).request('/api/weather', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves the longer 7-day/3-day series with one provider request per model and a small body', async () => {
    const calls: string[] = [];
    const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));
    const provider = createWeatherProvider({
      fetch: async (url) => {
        const target = String(url);
        calls.push(target);
        return new Response(JSON.stringify(fixture(target.includes('/v1/ecmwf') ? 'open-meteo-ecmwf-7d.json' : 'open-meteo-dmi-7d.json')), { status: 200 });
      },
      now: () => Date.parse('2026-09-30T12:00:00Z'),
    });
    const service = createWeatherService({ reader: provider, now: () => new Date('2026-09-30T12:00:00Z') });
    const res = await app({ readWeather: () => service.readWeather() }).request('/api/weather', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(new TextEncoder().encode(text).length).toBeLessThan(WEATHER_MAX_BODY_BYTES);
    const body = WeatherResponse.parse(JSON.parse(text));
    if (body.status !== 'ok') throw new Error('expected an ok projection');
    expect(body.projection.models.map((series) => [series.model, series.points.length])).toEqual([['dmi_harmonie_arome_europe', 72], ['ecmwf_ifs', 168]]);
    expect(calls).toHaveLength(2);
  });
});
