import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('Health card opens the history view lazily and switches to 1 y', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const health = page.getByRole('article', { name: 'Health', exact: true });

  expect(api.healthHistoryReads).toBe(0); // nothing loads until the toggle is pressed
  const toggle = health.getByRole('button', { name: 'History', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  await expect(health.getByRole('group', { name: 'History range', exact: true })).toBeVisible();
  await expect.poll(() => api.healthHistoryReads).toBe(1);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(health.getByText('Range median').first()).toBeVisible();

  await health.getByRole('group', { name: 'History range' }).getByRole('button', { name: '1 y', exact: true }).click();
  await expect(health.getByRole('button', { name: '1 y', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(api.healthHistoryReads).toBe(1); // switching range re-slices client-side
});
