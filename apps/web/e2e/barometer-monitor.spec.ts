// The Barometer card end to end on the Board at phone width: one summary line collapsed; expanded, the dial with its
// needle, the faint 3 h hand, the trend caption and the footer that names the source, place and observation time.
import { expect, test } from '@playwright/test';
import { barometerFixture } from './barometer-fixture.ts';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('the Board shows the Barometer collapsed: one summary line, no overflow', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Barometer', exact: true });
  await expect(card.locator('.baro-summary')).toHaveText('1020.2 hPa · ↑ 1.3 in 3 h · Fair');
  const line = await card.locator('.baro-summary').boundingBox();
  expect(line!.height).toBeLessThan(32);
  await expect(card.locator('.baro-dial')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('expanded, the card draws the dial and names the source, Trianglen and the observation time', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Barometer', exact: true });
  await card.getByRole('button', { name: 'Barometer', exact: true }).click();
  const dial = card.getByRole('img', { name: 'Barometer 1020.2 hPa, rising 1.3 hPa in 3 hours, Fair' });
  await expect(dial).toBeVisible();
  await expect(dial.locator('.baro-needle')).toHaveCount(1);
  await expect(dial.locator('.baro-set')).toHaveCount(1);
  await expect(dial.locator('.baro-zone')).toHaveCount(5);
  await expect(dial.locator('.baro-value')).toHaveText('1020.2');
  await expect(card.locator('.baro-footer')).toContainText('DMI measured · Trianglen · 13:50');
  const box = await dial.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(334);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a model fallback is labelled as a model, never as measured', async ({ page }) => {
  const api = new MockApi();
  api.barometer = barometerFixture({ source: 'model' });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Barometer', exact: true });
  await expect(card.locator('.baro-summary')).toContainText('· model');
  await expect(card.locator('.baro-footer')).toContainText('Model (Open-Meteo)');
  await expect(card.locator('.baro-footer')).not.toContainText('DMI measured');
});

test('unavailable pressure shows the reason and no number or dial', async ({ page }) => {
  const api = new MockApi();
  api.barometer = { status: 'unavailable', now: '2026-09-30T12:00:00.000Z', reason: 'empty', note: 'No recent pressure reading is available.' };
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Barometer', exact: true });
  await expect(card).toContainText('No recent pressure reading is available.');
  await expect(card.locator('.baro-summary, .baro-dial, .baro-footer')).toHaveCount(0);
});
