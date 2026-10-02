import { expect, test } from '@playwright/test';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

test('History: two days newest first; Reopen only for this device’s completion, via the existing Undo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  api.open = [taskView(3, 'Water the plants')];
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(page.getByRole('region', { name: 'Done today' }).getByText('Saved to GitHub')).toBeVisible();

  await goTo(page, 'Progress');
  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(history.getByRole('heading', { level: 2 })).toHaveText(['Thu 24 Sep', 'Wed 23 Sep']);
  const today = history.getByRole('region', { name: 'Thu 24 Sep' });
  const earlier = history.getByRole('region', { name: 'Wed 23 Sep' });
  await expect(today).toContainText('Water the plants');
  await expect(earlier).toContainText('Garden plan: beds ready');
  await expect(earlier).toContainText('reopen in Obsidian');
  await expect(earlier.getByRole('button', { name: 'Open note: Garden Plan' })).toBeVisible();
  await expect(history.getByRole('button', { name: /^Reopen/ })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await today.getByRole('button', { name: 'Reopen: Water the plants' }).click();
  await expect.poll(() => api.applied.length).toBe(2);
  const [complete, undo] = api.applied;
  expect(undo?.type === 'UndoCompleteTask' && undo.payload.target).toEqual(complete);
  await expect(history.getByRole('region', { name: 'Thu 24 Sep' })).toHaveCount(0);
  await expect(history.getByRole('heading', { level: 2 })).toHaveText(['Wed 23 Sep']);
});
