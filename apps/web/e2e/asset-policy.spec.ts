import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MockApi } from './mock-api.ts';

// Chromium enforces geolocation Permissions-Policy; WebKit's grantPermissions emulation bypasses it.
test('production asset policy permits explicit same-origin device location with real browser permission', async ({ page, context }) => {
  const policy = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').match(/^\s*Permissions-Policy: (.+)$/m)?.[1];
  expect(policy).toBeDefined();
  // Vite preview does not apply Cloudflare _headers: serve the checked-in production policy on the HTML.
  await page.route('**/', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Permissions-Policy': policy! } });
  });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 55.68123, longitude: 12.57123 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const morning = page.getByRole('region', { name: 'This morning weather' });
  await morning.getByRole('button', { name: 'Weather' }).click();
  expect(api.weatherLocationReads).toBe(0);
  await morning.getByRole('button', { name: 'Use my device location' }).click();
  await expect.poll(() => api.weatherLocationReads).toBe(1);
  expect(JSON.parse(api.weatherLocationBodies[0]!)).toEqual({ latitude: 55.68, longitude: 12.57 });
});

