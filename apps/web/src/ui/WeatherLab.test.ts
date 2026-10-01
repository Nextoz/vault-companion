import { WeatherProjection, WeatherResponse, type WeatherProjection as WeatherProjectionType } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWeather, postWeatherLocation, type Fetched } from '../api.ts';
import { runWindowSummary, WeatherLab, WeatherMorning, weatherFresh, weatherSegments } from './WeatherLab.tsx';

vi.mock('../api.ts', () => ({ getWeather: vi.fn(), postWeatherLocation: vi.fn() }));

const NOW = '2026-09-30T12:00:00Z';
const point = (hour: number, over: Record<string, unknown> = {}) => ({
  time: new Date(Date.parse('2026-09-30T06:00:00Z') + hour * 3_600_000).toISOString(),
  temperatureC: 14 + hour, rainMm: hour === 0 ? 0.1 : hour === 1 ? 0.2 : 1, windMs: 4 + hour * 0.5,
  ...over,
});
const modelSeries = (model: 'dmi_harmonie_arome_europe' | 'ecmwf_ifs') => ({
  model, label: model === 'dmi_harmonie_arome_europe' ? 'DMI HARMONIE AROME Europe' : 'ECMWF IFS 9 km',
  resolutionKm: model === 'dmi_harmonie_arome_europe' ? 2 : 9,
  sourceUrl: `https://open-meteo.com/en/docs/${model === 'dmi_harmonie_arome_europe' ? 'dmi-api' : 'ecmwf-api'}`,
  retrievedAt: NOW, expectedPoints: 48,
  points: [point(0), point(1), point(3), point(4)],
  missingIntervals: 44,
});
const projection = (): WeatherProjectionType => WeatherProjection.parse({
  location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
  now: NOW,
  models: [modelSeries('dmi_harmonie_arome_europe'), modelSeries('ecmwf_ifs')],
  agreement: 'two-models',
  coverage: { expectedPoints: 48, primaryReturned: 4, comparisonReturned: 4, primaryMissingIntervals: 44, comparisonMissingIntervals: 44 },
  runWindow: {
    day: '2026-09-30', daytimeStart: '08:00', daytimeEnd: '20:00',
    start: '2026-09-30T06:00:00Z', end: '2026-09-30T08:00:00Z',
    agreement: 'two-models', models: ['dmi_harmonie_arome_europe', 'ecmwf_ifs'], rainMm: 0.3,
    rainRangeMm: { min: 0.3, max: 0.5 }, temperatureRangeC: { min: 14, max: 15 }, windRangeMs: { min: 4, max: 5 },
    note: 'Lowest-rain two-hour window inside Copenhagen daytime 08:00-20:00. Not a guarantee of dry or daylight weather.',
  },
  partialError: 'none',
  attribution: 'Forecast data by DMI and ECMWF via Open-Meteo, CC-BY 4.0.',
  termsUrl: 'https://open-meteo.com/en/terms',
});

const okResponse = (): Fetched<WeatherResponse> => ({ kind: 'ok', data: WeatherResponse.parse({ status: 'ok', projection: projection() }) });

describe('weather pure helpers', () => {
  it('splits chart segments only where an hourly bucket is missing', () => {
    const points = [point(0), point(1), point(3), point(4)];
    expect(weatherSegments(points)).toEqual([[0, 1], [2, 3]]);
  });

  it('measures freshness from the projection server now, never the device clock', () => {
    expect(weatherFresh(projection(), Date.parse(NOW))).toBe(true);
    expect(weatherFresh(projection(), Date.parse(NOW) + 15 * 60_000 + 1)).toBe(false);
  });

  it('splits a plotted variable at null values without breaking other variables', () => {
    const points = [point(0), point(1, { rainMm: null }), point(2), point(3)];
    expect(weatherSegments(points, 'rain')).toEqual([[0], [2, 3]]);
    expect(weatherSegments(points, 'temperature')).toEqual([[0, 1, 2, 3]]);
  });

  it('summarises the two-hour daytime window without claiming dry or daylight weather', () => {
    expect(runWindowSummary(projection().runWindow)).toContain('Two models cover this window');
    expect(runWindowSummary(projection().runWindow)).toContain('lowest-rain window');
    expect(runWindowSummary(null)).toContain('No two-hour daytime window');
  });
});

describe('WeatherLab full inspector', () => {
  let dom: JSDOM;
  let root: Root | null = null;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/', pretendToBeVisual: true });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    dom.window.close();
    vi.clearAllMocks();
  });

  it('renders provider attribution, model sources, variable controls and keyboard inspection', async () => {
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(WeatherLab, { projection: projection() })); });
    const text = document.getElementById('root')!.textContent ?? '';
    expect(text).toContain('DMI HARMONIE AROME Europe');
    expect(text).toContain('ECMWF IFS 9 km');
    expect(text).toContain('CC-BY 4.0');
    expect(document.querySelectorAll('a').length).toBeGreaterThanOrEqual(3);
    const temperature = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Temperature')!;
    await act(async () => { temperature.click(); });
    expect(temperature.getAttribute('aria-pressed')).toBe('true');
    const slider = document.querySelector('.weather-slider') as HTMLInputElement;
    expect(slider).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(slider, '1');
      slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    expect(document.querySelector('.weather-readout')!.textContent).toContain('°C');
  });

  it('turns a fresh mounted forecast stale as monotonic time advances without fetching', async () => {
    vi.useFakeTimers();
    try {
      root = createRoot(document.getElementById('root')!);
      await act(async () => { root!.render(createElement(WeatherLab, { projection: projection() })); });
      expect(document.getElementById('root')!.textContent).not.toContain('Not refreshed');
      await act(async () => { vi.advanceTimersByTime(16 * 60_000); });
      expect(document.getElementById('root')!.textContent).toContain('Not refreshed');
      expect(getWeather).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('WeatherMorning Today projection and fences', () => {
  let dom: JSDOM;
  let root: Root | null = null;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/', pretendToBeVisual: true });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    vi.mocked(getWeather).mockResolvedValue(okResponse());
    vi.mocked(postWeatherLocation).mockResolvedValue(okResponse());
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    dom.window.close();
    vi.clearAllMocks();
  });

  const render = async () => {
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(WeatherMorning, { refreshKey: 0, accountKey: 'a'.repeat(64) })); });
  };

  it('shows the compact summary and opens the same shared projection on tap', async () => {
    await render();
    const summary = document.querySelector('[data-testid="weather-morning-summary"]')!;
    expect(summary.textContent).toContain('lowest-rain window');
    const toggle = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Weather')!;
    await act(async () => { toggle.click(); });
    expect(document.querySelector('.weather-lab')).not.toBeNull();
    expect(document.getElementById('root')!.textContent).toContain('ECMWF IFS 9 km');
  });

  it('ignores a reply that lands after unmount (no stale account content)', async () => {
    let resolve!: (value: Fetched<WeatherResponse>) => void;
    vi.mocked(getWeather).mockReturnValue(new Promise((r) => { resolve = r; }));
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(WeatherMorning, { refreshKey: 0, accountKey: 'a'.repeat(64) })); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { resolve(okResponse()); await Promise.resolve(); });
    expect(document.getElementById('root')!.textContent).toBe('');
  });

  it('denied geolocation stays on the coarse fallback and never posts device coordinates', async () => {
    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_success: unknown, error?: ((e: { code: number }) => void) | null) => error?.({ code: 1 }) },
    });
    await render();
    const toggle = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Weather')!;
    await act(async () => { toggle.click(); });
    const useLocation = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use my device location')!;
    await act(async () => { useLocation.click(); });
    expect(document.getElementById('root')!.textContent).toContain('Location permission denied');
    expect(postWeatherLocation).not.toHaveBeenCalled();
  });

  it('does not send a device-location request after the view unmounts', async () => {
    let success!: PositionCallback;
    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (callback: PositionCallback) => { success = callback; } },
    });
    await render();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Weather')!.click(); });
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use my device location')!.click(); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { success({ coords: { latitude: 55.68123, longitude: 12.57123 } } as GeolocationPosition); });
    expect(postWeatherLocation).not.toHaveBeenCalled();
  });

  it('clears a late hidden location attempt without posting coordinates', async () => {
    let success!: PositionCallback;
    Object.defineProperty(dom.window.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (callback: PositionCallback) => { success = callback; } } });
    await render();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Weather')!.click(); });
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use my device location')!.click(); });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { success({ coords: { latitude: 55.68123, longitude: 12.57123 } } as GeolocationPosition); });
    expect(document.getElementById('root')!.textContent).not.toContain('Finding device location');
    expect(document.getElementById('root')!.textContent).toContain('not used while hidden or offline');
    expect(postWeatherLocation).not.toHaveBeenCalled();
  });

  it('does not call position-unavailable a permission denial', async () => {
    Object.defineProperty(dom.window.navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: (_success: unknown, error: PositionErrorCallback) => error({ code: 2 } as GeolocationPositionError) } });
    await render();
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Weather')!.click(); });
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Use my device location')!.click(); });
    expect(document.getElementById('root')!.textContent).toContain('could not be obtained');
    expect(document.getElementById('root')!.textContent).not.toContain('permission denied');
  });
});
