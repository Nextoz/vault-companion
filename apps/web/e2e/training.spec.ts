import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { waitForSettledRetry } from './settled-retry.ts';

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Add training', exact: true }).click();
  return page.getByRole('dialog', { name: 'Log training', exact: true });
}
test('run and gym logging, newest-first list, notes, yesterday placement and exact Undo', async ({ page }) => {
  const api = new MockApi();
  api.trainingUnknownLines = ['| unknown | keep these bytes |'];
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const list = page.getByRole('region', { name: 'Training sessions' });
  await expect(list).toContainText('No sessions yet');
  await expect(list).toContainText('| unknown | keep these bytes |');
  let sheet = await openSheet(page);
  await expect(sheet.getByLabel('When', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveValue('');
  await sheet.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveCount(0);
  await expect(sheet.getByLabel('Split', { exact: true })).toHaveCount(0);
  await sheet.getByLabel('When', { exact: true }).fill('2026-09-28T10:00');
  await sheet.getByLabel('Distance (km)').fill('5.2');
  await sheet.getByLabel('Duration (min)').fill('28');
  await sheet.getByLabel('Note (optional)').fill('Easy loop');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(1);
  await expect(list).toContainText('5.2 km · 28 min · 5:23 /km');
  await expect(list.getByText('Easy loop')).toBeHidden();
  await list.getByLabel('Show session note').click();
  await expect(list.getByText('Easy loop')).toBeVisible();

  sheet = await openSheet(page);
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveValue('');
  await expect(sheet.getByLabel('Distance (km)')).toHaveCount(0);
  await sheet.getByLabel('When', { exact: true }).fill('2026-09-28T18:00');
  await sheet.getByLabel('Duration (min)').fill('60');
  await sheet.getByLabel('Weight (kg, optional)').fill('82.4');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(2);
  await expect(list.getByTestId('training-row').first()).toContainText('Bicep · 60 min · 82.4 kg');
  await expect(list.getByTestId('training-row').nth(1)).toContainText('Run');

  sheet = await openSheet(page);
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveValue('');
  await sheet.getByLabel('When', { exact: true }).fill('2026-09-27T17:00');
  await sheet.getByRole('combobox', { name: 'Split', exact: true }).selectOption({ label: 'Legs' });
  await sheet.getByLabel('Duration (min)').fill('45');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(3);
  await expect(list.getByTestId('training-row').last()).toContainText('2026-09-27');
  const action = page.getByTestId('action').filter({ hasText: '2026-09-27' });
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(2);
  expect(api.applied.map((c) => c.type)).toEqual(['LogTraining', 'LogTraining', 'LogTraining', 'UndoLogTraining']);
  const gym = api.applied[1];
  expect(gym?.type === 'LogTraining' && gym.payload.session).toMatchObject({ type: 'Gym', weight: 82.4, duration: 60 });
});

test('offline save survives reload and dependent Undo waits for the receipt', async ({ page }) => {
  const api = new MockApi(); await api.install(page); await page.goto('/');
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  const sheet = await openSheet(page);
  await sheet.getByLabel('Duration (min)').fill('60');
  api.commandMode = 'offline';
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('action')).toContainText('Training');
  await expect.poll(() => api.bodies.length).toBeGreaterThan(0);
  // Reload only after the failed attempt is stored and its send lease released (see settled-retry.ts);
  // a reload mid-send leaves the action leased and the Refresh kick below would be skipped.
  await waitForSettledRetry(page);
  await page.reload();
  await expect(page.getByTestId('action')).toContainText('Training');
  api.commandMode = 'hold';
  await page.getByRole('button', { name: 'Refresh vault', exact: true }).click();
  await expect.poll(() => api.heldCount).toBe(1);
  await page.getByTestId('action').getByRole('button', { name: 'Undo', exact: true }).click();
  expect(api.applied).toHaveLength(0);
  api.release();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['LogTraining', 'UndoLogTraining']);
  expect(api.trainingRows).toEqual([]);
});

test('six complete tab labels fit 390 px without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi(); await api.install(page); await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Views' });
  await expect(nav.getByRole('button')).toHaveText(['Today', 'All', 'Notes', 'Training', 'Scouts', 'Progress']);
  const bounds = await nav.evaluate((el) => {
    const bar = el.getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, width: innerWidth, labels: [...el.querySelectorAll('button')].map((b) => {
      const r = document.createRange(); r.selectNodeContents(b); const label = r.getBoundingClientRect(); const box = b.getBoundingClientRect();
      return label.left >= Math.max(bar.left, box.left) && label.right <= Math.min(bar.right, box.right) && b.scrollWidth <= b.clientWidth;
    }) };
  });
  expect(bounds.page).toBeLessThanOrEqual(bounds.width);
  expect(bounds.labels).toEqual([true, true, true, true, true, true]);
  await nav.getByRole('button', { name: 'Training', exact: true }).click();
  await openSheet(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
