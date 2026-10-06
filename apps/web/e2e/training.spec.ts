import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { waitForSettledRetry } from './settled-retry.ts';
import { goTo } from './nav.ts';

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Add training', exact: true }).click();
  return page.getByRole('dialog', { name: 'Log training', exact: true });
}
test('run and gym logging, newest-first list, notes, yesterday placement and exact Undo', async ({ page }) => {
  const api = new MockApi();
  api.trainingUnknownLines = ['| unknown | keep these bytes |'];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  const list = page.getByRole('region', { name: 'Training sessions' });
  await expect(list).toContainText('No sessions yet');
  await expect(list).toContainText('| unknown | keep these bytes |');
  let sheet = await openSheet(page);
  await expect(sheet.getByLabel('When', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveValue('');
  await sheet.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveCount(0);
  await expect(sheet.getByLabel('Workout', { exact: true })).toHaveCount(0);
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
  await sheet.getByLabel('Weight (kg, optional)').fill('82,4'); // B1: Danish comma
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(2);
  await expect(list.getByTestId('training-row').first()).toContainText('Bicep · 60 min · 82.4 kg');
  await expect(list.getByTestId('training-row').nth(1)).toContainText('Run');

  sheet = await openSheet(page);
  await expect(sheet.getByLabel('Weight (kg, optional)')).toHaveValue('');
  await sheet.getByLabel('When', { exact: true }).fill('2026-09-27T17:00');
  await sheet.getByRole('combobox', { name: 'Workout', exact: true }).selectOption({ label: 'Legs' });
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

test('group class uses a suggested name and shows it in the Workout cell', async ({ page }) => {
  const api = new MockApi();
  api.trainingRows = [{ date: '2026-09-20', time: '08:00', type: 'Gym', distance: '', duration: '45', weight: '', split: 'Group: Functional Express', note: '' }];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  const list = page.getByRole('region', { name: 'Training sessions' });
  const sheet = await openSheet(page);
  await sheet.getByRole('combobox', { name: 'Workout', exact: true }).selectOption({ label: 'Group training' });
  await expect(sheet.getByLabel('Class name', { exact: true })).toHaveValue('');
  await sheet.getByRole('button', { name: 'Functional Express', exact: true }).click();
  await expect(sheet.getByLabel('Class name', { exact: true })).toHaveValue('Functional Express');
  await sheet.getByLabel('When', { exact: true }).fill('2026-09-28T07:00');
  await sheet.getByLabel('Duration (min)').fill('45');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(list.getByTestId('training-row')).toHaveCount(2);
  await expect(list.getByTestId('training-row').first()).toContainText('Group: Functional Express');
  const logged = api.applied[0];
  expect(logged?.type === 'LogTraining' && logged.payload.session).toMatchObject({ type: 'Gym', split: 'Group', className: 'Functional Express', duration: 45 });
});

test('offline save survives reload and dependent Undo waits for the receipt', async ({ page }) => {
  const api = new MockApi(); await api.install(page); await page.goto('/');
  await goTo(page, 'Log');
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
  await goTo(page, 'Tasks'); // UX8: Refresh lives with Vault status on the Tasks tab, not on Today
  await page.getByRole('button', { name: 'Refresh vault', exact: true }).click();
  await expect.poll(() => api.heldCount).toBe(1);
  await page.getByTestId('action').getByRole('button', { name: 'Undo', exact: true }).click();
  expect(api.applied).toHaveLength(0);
  api.release();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['LogTraining', 'UndoLogTraining']);
  expect(api.trainingRows).toEqual([]);
});

test('editing a logged Gym session prefills, saves the changed cells, and Undo restores it', async ({ page }) => {
  const api = new MockApi();
  api.trainingRows = [{ date: '2026-09-20', time: '08:00', type: 'Gym', distance: '', duration: '45', weight: '', split: 'Group: Functional Express', note: 'Capped at 12' }];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  const list = page.getByRole('region', { name: 'Training sessions' });
  await list.getByRole('button', { name: 'Edit Gym session on 2026-09-20 at 08:00' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit session', exact: true });
  await expect(sheet.getByLabel('When', { exact: true })).toHaveValue('2026-09-20T08:00');
  await expect(sheet.getByRole('combobox', { name: 'Workout', exact: true })).toHaveValue('Group');
  await expect(sheet.getByLabel('Class name', { exact: true })).toHaveValue('Functional Express');
  await expect(sheet.getByLabel('Duration (min)')).toHaveValue('45');
  await expect(sheet.getByLabel('Note (optional)')).toHaveValue('Capped at 12');
  await sheet.getByLabel('Duration (min)').fill('52');
  await sheet.getByLabel('Class name', { exact: true }).fill('Functional Power');
  await sheet.getByRole('button', { name: 'Save changes', exact: true }).click();
  const row = list.getByTestId('training-row');
  await expect(row).toContainText('Group: Functional Power');
  await expect(row).toContainText('52 min');
  await expect(row).toContainText('Capped at 12');
  const edit = api.applied.find((c) => c.type === 'EditTraining');
  expect(edit?.type === 'EditTraining' && edit.payload.row).toEqual({
    date: '2026-09-20', time: '08:00', type: 'Gym', distance: '', duration: '45', weight: '', split: 'Group: Functional Express', note: 'Capped at 12',
  });
  const action = page.getByTestId('action').filter({ hasText: 'Edit training' });
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row).toContainText('Group: Functional Express');
  await expect(row).toContainText('45 min');
  expect(api.applied.map((c) => c.type)).toEqual(['EditTraining', 'UndoEditTraining']);
});

test('five complete tab labels fit 390 px without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi(); await api.install(page); await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Views' });
  await expect(nav.getByRole('button')).toHaveText(['Today', 'Tasks', 'Scouts', 'Notes', 'Log']);
  const bounds = await nav.evaluate((el) => {
    const bar = el.getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, width: innerWidth, labels: [...el.querySelectorAll('button')].map((b) => {
      const r = document.createRange(); r.selectNodeContents(b); const label = r.getBoundingClientRect(); const box = b.getBoundingClientRect();
      return label.left >= Math.max(bar.left, box.left) && label.right <= Math.min(bar.right, box.right) && b.scrollWidth <= b.clientWidth;
    }) };
  });
  expect(bounds.page).toBeLessThanOrEqual(bounds.width);
  expect(bounds.labels).toEqual([true, true, true, true, true]);
  await goTo(page, 'Log');
  await openSheet(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
