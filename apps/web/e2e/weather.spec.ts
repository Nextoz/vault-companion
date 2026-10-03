import { expect, test } from '@playwright/test';
import { MockApi, sampleWeather } from './mock-api.ts';
import { goTo } from './nav.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Guard against replacing the API mock with a live public-provider request.
  await page.route('https://api.open-meteo.com/**', (route) => {
    throw new Error(`Unexpected browser provider request: ${route.request().url()}`);
  });
});

test('Dashboard mounts Weather with attribution, model comparison and touch/keyboard inspection', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const dashboard = page.getByRole('region', { name: 'Dashboard', exact: true });
  const weather = dashboard.getByRole('article', { name: 'Weather', exact: true });
  await expect(weather.locator('.dash-chip')).toHaveText('Live');
  await expect(weather).toContainText('DMI HARMONIE AROME Europe');
  await expect(weather).toContainText('ECMWF IFS 9 km');
  await expect(weather).toContainText('CC-BY 4.0');
  await expect(weather.locator('a', { hasText: 'Source' })).toHaveCount(2);
  await expect(weather).toContainText('lowest-rain window');
  const readsBeforeInspection = api.weatherReads;

  await weather.getByRole('button', { name: 'Temperature', exact: true }).click();
  await expect(weather.getByRole('button', { name: 'Temperature', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(weather.getByRole('img').first()).toBeVisible();
  const slider = weather.getByRole('slider', { name: 'Inspect forecast time', exact: true });
  await slider.focus();
  await slider.press('ArrowLeft');
  await expect(weather.locator('figcaption')).toContainText('°C');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(api.weatherReads).toBe(readsBeforeInspection); // chart interaction uses the Dashboard projection; initial Today reads are separate
});

test('Today shows the compact weather morning projection and opens the same shared read model', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  // UX2: the weather line on the morning card opens the same compact panel.
  // UX4: that line is now the short glance from sampleWeather() (rain 0.3mm, 06:00–08:00Z, 15°C max, 4 m/s max).
  await page.getByRole('button', { name: /^Wet 06–08 · 15° · breezy/ }).click();
  const morning = page.getByRole('region', { name: 'This morning weather', exact: true });
  await expect(morning.getByTestId('weather-morning-summary')).toContainText('lowest-rain window');
  await expect(morning.getByTestId('weather-morning-summary')).toContainText('Two models cover this window');
  await morning.getByRole('button', { name: 'Weather', exact: true }).click();
  await expect(morning.locator('.weather-lab')).toBeVisible();
  await expect(morning.locator('.weather-lab')).toContainText('ECMWF IFS 9 km');
  expect(api.weatherReads).toBeGreaterThan(0);
});

test('partial comparison failure is labelled single-model, not a made-up agreement', async ({ page }) => {
  const api = new MockApi();
  api.weather = sampleWeather(true);
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const weather = page.getByRole('region', { name: 'Dashboard' }).getByRole('article', { name: 'Weather' });
  await expect(weather).toContainText('one model unavailable');
  await expect(weather).toContainText('One model covers this window');
  await expect(weather.locator('button', { hasText: 'Compare' })).toHaveCount(0);
});

test('denied device geolocation keeps the honest coarse Copenhagen fallback and never sends coordinates', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (_success: PositionCallback, error?: PositionErrorCallback | null) => error?.({ code: 1, message: 'denied' } as GeolocationPositionError) },
    });
  });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  // UX4: the morning line is the short weatherGlance; sampleWeather() yields "Wet 06–08 · 15° · breezy".
  await page.getByRole('button', { name: /^Wet 06–08 · 15° · breezy/ }).click();
  const morning = page.getByRole('region', { name: 'This morning weather' });
  await morning.getByRole('button', { name: 'Weather' }).click();
  await morning.getByRole('button', { name: 'Use my device location' }).click();
  await expect(morning).toContainText('Location permission denied — using the coarse Copenhagen fallback.');
  expect(api.weatherLocationReads).toBe(0);
});

test('unavailable weather stays honest on Dashboard and Today', async ({ page }) => {
  const api = new MockApi();
  api.weather = { status: 'unavailable', now: '2026-09-30T12:00:00Z', location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' }, reason: 'provider-error', message: 'No weather model returned usable forecast points.' };
  await api.install(page);
  await page.goto('/');
  // The honest failure is the line's copy; tapping it opens the same panel that scrolls its detail.
  await page.getByRole('button', { name: /No weather model returned usable forecast points/ }).click();
  await expect(page.getByRole('region', { name: 'This morning weather' })).toContainText('No weather model returned usable forecast points.');
  await goTo(page, 'Today');
  const weather = page.getByRole('region', { name: 'Dashboard' }).getByRole('article', { name: 'Weather' });
  await expect(weather.locator('.dash-chip')).toHaveText('Unavailable');
  await expect(weather).toContainText('Weather is unavailable.');
});
