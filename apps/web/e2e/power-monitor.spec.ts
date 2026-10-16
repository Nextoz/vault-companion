// M4c3: the Power (DK2) card end to end — the shared powerFixture served through MockApi, on the Board at phone
// width. Collapsed it is one summary line; expanded it is the 24-hour chart with the day tabs.
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';
import { powerFixture } from './power-fixture.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('M4c3: the Board shows the Power card collapsed: one summary line, a small card, no overflow', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Power (DK2)', exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator('.power-summary')).toContainText('Now 1.96 kr');
  const box = await card.boundingBox();
  // Heading + one summary line + freshness footer; the summary itself must never wrap to a second line.
  expect(box!.height).toBeLessThanOrEqual(170);
  const line = await card.locator('.power-summary').boundingBox();
  expect(line!.height).toBeLessThan(32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('M4c3: expanded, the card charts 24 hours and the tabs switch days; the footer names the source', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Power (DK2)', exact: true });
  await card.getByRole('button', { name: 'Power (DK2)', exact: true }).click();
  await expect(card.locator('.power-bar')).toHaveCount(24);
  await card.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(card.locator('.power-bar')).toHaveCount(24);
  await expect(card).toContainText('Cheapest 3 h · 12-15');
  await expect(card.locator('.power-updated')).toContainText('Energi Data Service · Updated');
});

test('M4c3: before tomorrow is published, the Tomorrow tab shows the note and no bars', async ({ page }) => {
  const api = new MockApi();
  api.power = powerFixture({ tomorrowPublished: false });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Board');
  const card = page.getByRole('region', { name: 'Power (DK2)', exact: true });
  await card.getByRole('button', { name: 'Power (DK2)', exact: true }).click();
  await card.getByRole('button', { name: 'Tomorrow', exact: true }).click();
  await expect(card).toContainText('not published yet');
  await expect(card.locator('.power-bar')).toHaveCount(0);
});
