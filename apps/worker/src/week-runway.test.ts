import {
  TriageResponse,
  WeatherResponse,
  WeekRunwayResponse,
  WEATHER_ATTRIBUTION,
  WEATHER_FALLBACK_LOCATION,
  WEATHER_TERMS_URL,
  type ApiError,
} from '@vault-companion/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type Services } from './app.ts';
import type { CalendarBusyInterval } from './google-reader.ts';
import { createWeekRunwayService, type WeekRunwayServiceDeps } from './week-runway.ts';

const ORIGIN = 'https://vc.example.com';
const ACCOUNT = 'a'.repeat(64);
const NOW = new Date('2026-10-16T14:05:00Z');
const TZ = 'Europe/Copenhagen';
// Local 17:00 of 2026-10-16 and local 23:00 of 2026-10-22, Copenhagen still on CEST (UTC+2).
const TIME_MIN = '2026-10-16T15:00:00.000Z';
const TIME_MAX = '2026-10-22T21:00:00.000Z';
const DAYS = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];

// Synthetic 19:00-20:00 local busy block on the fourth evening (2026-10-19).
const busyIntervals: readonly CalendarBusyInterval[] = [{ start: '2026-10-19T17:00:00Z', end: '2026-10-19T18:00:00Z' }];
const apiError: ApiError = { code: 'upstream-unavailable', message: 'reader unavailable', retryable: true };

const weatherOk = WeatherResponse.parse({
  status: 'ok',
  projection: {
    location: WEATHER_FALLBACK_LOCATION,
    now: '2026-10-16T14:05:00Z',
    models: [{
      model: 'ecmwf_ifs',
      label: 'ECMWF IFS 9 km',
      resolutionKm: 9,
      sourceUrl: 'https://open-meteo.com/en/docs/ecmwf-api',
      retrievedAt: '2026-10-16T13:05:00Z',
      expectedPoints: 1,
      points: [{ time: '2026-10-16T15:00:00Z', temperatureC: 16.5, rainMm: 0, windMs: 3, windDirectionDeg: 180, precipitationProbabilityPct: null, weatherCode: 3 }],
      missingIntervals: 0,
    }],
    agreement: 'single-model',
    coverage: { expectedPoints: 1, primaryReturned: 1, comparisonReturned: 0, primaryMissingIntervals: 0, comparisonMissingIntervals: 0 },
    runWindow: null,
    partialError: 'none',
    attribution: WEATHER_ATTRIBUTION,
    termsUrl: WEATHER_TERMS_URL,
    week: DAYS.map((day) => ({
      day, lowTemperatureC: 9.5, highTemperatureC: 16.5, rainMm: 0.2, precipitationProbabilityPct: 10,
      weatherCode: 3, models: 2, partial: false, runWindow: null,
    })),
  },
});

const weatherUnavailable = WeatherResponse.parse({
  status: 'unavailable',
  now: '2026-10-16T14:05:00Z',
  location: WEATHER_FALLBACK_LOCATION,
  reason: 'provider-error',
  message: 'No weather.',
});

const triageEmpty: TriageResponse = {
  revision: 'e'.repeat(40),
  now: '2026-10-16T14:05:00Z',
  feedState: 'ok',
  generatedAt: null,
  cards: [],
  checkins: [],
  droppedCards: 0,
  droppedCheckins: 0,
  decisions: [],
  applied: {},
  appliedUpdatedAt: null,
};

const makeService = (over: Partial<WeekRunwayServiceDeps> = {}) =>
  createWeekRunwayService({
    readWeather: async () => weatherOk,
    readTriage: async () => triageEmpty,
    createReader: null,
    now: () => NOW,
    timeZone: TZ,
    ...over,
  });

describe('week runway service (M8)', () => {
  it('reads busy once within the TTL and bounds the read to the seven local evenings', async () => {
    const readBusy = vi.fn(async () => busyIntervals);
    const createReader = vi.fn(() => ({ readBusy }));
    const service = makeService({ createReader });
    const first = await service.readWeekRunway();
    const second = await service.readWeekRunway();
    expect(readBusy).toHaveBeenCalledTimes(1);
    expect(readBusy).toHaveBeenCalledWith(TIME_MIN, TIME_MAX);
    expect(createReader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.sources).toEqual({ calendar: 'ok', weather: 'ok', triage: 'ok' });
    expect(first.evenings.map((evening) => evening.day)).toEqual(DAYS);
    expect(first.evenings[3]).toMatchObject({ state: 'busy', weatherCode: 3, highTemperatureC: 16.5 });
    expect(first.evenings[0]).toMatchObject({ state: 'free', weatherCode: 3 });
    expect(first.counts).toEqual({ free: 6, busy: 1, picked: 0 });
    expect(WeekRunwayResponse.safeParse(first).success).toBe(true);
  });

  it('refreshes the busy read with a new reader after the TTL', async () => {
    const readBusy = vi.fn(async () => busyIntervals);
    const createReader = vi.fn(() => ({ readBusy }));
    let nowMs = NOW.getTime();
    const service = makeService({ createReader, now: () => new Date(nowMs) });
    await service.readWeekRunway();
    nowMs += 600_001;
    const refreshed = await service.readWeekRunway();
    expect(readBusy).toHaveBeenCalledTimes(2);
    expect(createReader).toHaveBeenCalledTimes(2);
    expect(refreshed.sources.calendar).toBe('ok');
  });

  it('reports calendar unavailable on a failed busy read and retries it on the next call', async () => {
    let failOnce = true;
    const readBusy = vi.fn(async (): Promise<readonly CalendarBusyInterval[] | ApiError> => {
      if (failOnce) {
        failOnce = false;
        return apiError;
      }
      return busyIntervals;
    });
    const createReader = vi.fn(() => ({ readBusy }));
    const service = makeService({ createReader });
    const failed = await service.readWeekRunway();
    expect(failed.sources.calendar).toBe('unavailable');
    expect(failed.evenings.every((evening) => evening.state === 'unknown')).toBe(true);
    const retried = await service.readWeekRunway();
    expect(readBusy).toHaveBeenCalledTimes(2);
    expect(createReader).toHaveBeenCalledTimes(2);
    expect(retried.sources.calendar).toBe('ok');
    expect(retried.evenings[3]).toMatchObject({ state: 'busy' });
  });

  it('leaves the calendar unavailable and evenings unknown without a reader', async () => {
    const result = await makeService({ createReader: null }).readWeekRunway();
    expect(result.sources).toEqual({ calendar: 'unavailable', weather: 'ok', triage: 'ok' });
    expect(result.evenings.every((evening) => evening.state === 'unknown')).toBe(true);
    expect(result.counts).toEqual({ free: 0, busy: 0, picked: 0 });
    expect(WeekRunwayResponse.safeParse(result).success).toBe(true);
  });

  it('reports weather unavailable when the weather read has no week projection', async () => {
    const result = await makeService({ readWeather: async () => weatherUnavailable }).readWeekRunway();
    expect(result.sources).toEqual({ calendar: 'unavailable', weather: 'unavailable', triage: 'ok' });
    expect(result.evenings[0]).toMatchObject({ highTemperatureC: null, weatherCode: null, state: 'unknown' });
  });

  it('degrades thrown source errors and triage API errors to unavailable without throwing', async () => {
    const result = await makeService({
      readWeather: async () => {
        throw new Error('provider down');
      },
      readTriage: async () => apiError,
    }).readWeekRunway();
    expect(result.sources).toEqual({ calendar: 'unavailable', weather: 'unavailable', triage: 'unavailable' });
    expect(result.evenings.every((evening) => evening.state === 'unknown')).toBe(true);
  });
});

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

describe('week runway route (M8)', () => {
  it('GET /api/week-runway requires an Access token', async () => {
    const res = await app().request('/api/week-runway', { headers: { 'Cf-Access-Jwt-Assertion': 'bad' } });
    expect(res.status).toBe(401);
  });

  it('answers 404 when the service is not composed', async () => {
    const res = await app().request('/api/week-runway', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
    expect(res.status).toBe(404);
  });

  it('serves a schema-valid runway through the composed service', async () => {
    const service = makeService({ createReader: null });
    const res = await app({ readWeekRunway: () => service.readWeekRunway() }).request('/api/week-runway', {
      headers: { 'Cf-Access-Jwt-Assertion': 'good' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = WeekRunwayResponse.parse(await res.json());
    expect(body.evenings.map((evening) => evening.day)).toEqual(DAYS);
    expect(body.sources).toEqual({ calendar: 'unavailable', weather: 'ok', triage: 'ok' });
  });
});
