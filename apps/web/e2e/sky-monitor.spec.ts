// M7c3: the Daylight & sky card end to end on the Board at phone width. Sun times are computed from the real clock,
// so the specs assert shapes, not clock values; Kp comes from the shared skyFixture served through MockApi.
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('M7c3: collapsed, the Sky card is one summary line, a small card, no overflow', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Daylight & sky', exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('.sky-summary')).toHaveText(/daylight · sunset \d\d:\d\d/);
  const box = await card.boundingBox();
  expect(box!.height).toBeLessThanOrEqual(170);
  const line = await card.locator('.sky-summary').boundingBox();
  expect(line!.height).toBeLessThan(32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('M7c3: expanded, the card shows the arc, three tiles with Kp 3, and names its Kp source', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Daylight & sky', exact: true });
  await card.getByRole('button', { name: 'Daylight & sky', exact: true }).click();
  await expect(card.locator('.sky-arc')).toBeVisible();
  await expect(card.locator('.sky-tile')).toHaveCount(3);
  await expect(card).toContainText('Kp 3');
  await expect(card.locator('.sky-updated')).toContainText('SunCalc · NOAA SWPC · Updated');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
