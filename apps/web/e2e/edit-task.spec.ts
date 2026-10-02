import { expect, test } from '@playwright/test';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

test('edit text and due, queue only changed fields, then show the reflected task', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(10, 'Water the plants')];
  api.commandMode = 'hold';
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit: Water the plants', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit task' });
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(sheet.getByLabel('Task text')).toHaveValue('Water the plants');
  await sheet.getByLabel('Task text').fill('Water the herbs');
  await sheet.getByLabel('Due', { exact: true }).fill('2026-09-25');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const row = page.getByRole('region', { name: 'Today', exact: true }).getByTestId('task');
  await expect(row).toContainText('Water the herbs');
  await expect(row).toContainText('Saving');
  await expect(row.getByRole('button', { name: /^Complete:|^Edit:/ })).toHaveCount(0);
  await expect.poll(() => api.bodies.length).toBe(1);
  const body = JSON.parse(api.bodies[0]!);
  expect(body.type).toBe('EditTask');
  expect(body.payload).toEqual({ task: taskView(10, 'Water the plants').locator,
    changes: { text: 'Water the herbs', due: '2026-09-25' } });
  api.release();
  await expect.poll(() => api.applied.length).toBe(1);
  await goTo(page, 'All');
  await expect(page.getByRole('button', { name: 'Edit: Water the herbs', exact: true })).toBeEnabled();
});

test('a trailing space from the keyboard is trimmed before the edit is sent', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(10, 'Water the plants')];
  api.commandMode = 'hold';
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit: Water the plants', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit task' });
  await sheet.getByLabel('Task text').fill('Water the herbs  ');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.bodies.length).toBe(1);
  expect(JSON.parse(api.bodies[0]!).payload.changes).toEqual({ text: 'Water the herbs' });
});

test('a task made only of note links still has an Edit button', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(12, '[[Garden Plan]]', { links: ['Garden Plan'] })];
  await api.install(page);
  await page.goto('/');
  const row = page.getByRole('region', { name: 'Today', exact: true }).getByTestId('task');
  await expect(row.getByRole('button', { name: /^Open note:/ })).toHaveCount(1);
  await row.getByRole('button', { name: /^Edit:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
});
