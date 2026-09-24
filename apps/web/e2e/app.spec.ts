import { expect, test, type Page } from '@playwright/test';
import { Command } from '@vault-companion/contracts';
import { MockApi, taskView } from './mock-api.ts';

let api: MockApi;

test.beforeEach(async ({ page }) => {
  api = new MockApi();
  api.open = [taskView(10, 'Water the plants'), taskView(11, 'Call the bike shop')];
  await api.install(page);
});

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const parsed = (bodies: string[]) => bodies.map((b) => Command.parse(JSON.parse(b)));

test('complete a task, then Undo it from the toast', async ({ page }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();

  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();

  // Optimistic: moved to Done today at once, with an honest state; calm toast with Undo.
  await expect(region(page, 'Done today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Today').getByText('Water the plants')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Done' })).toBeVisible();
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(region(page, 'Done today').getByText('Saved to GitHub')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => api.applied.length).toBe(2);
  const [complete, undo] = api.applied;
  expect(complete?.type).toBe('CompleteTask');
  expect(undo?.type).toBe('UndoCompleteTask');
  // Undo carries the original CompleteTask envelope verbatim.
  expect(undo?.type === 'UndoCompleteTask' && undo.payload.target).toEqual(complete);

  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(0);
});

test('capture offline, then send the identical envelope once back online', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();

  api.commandMode = 'offline';
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Note' }).click();
  await page.getByLabel('Note text').fill('A thought about the garden');
  await page.getByRole('button', { name: 'Save' }).click();

  const action = region(page, 'Actions on this device').getByTestId('action');
  await expect(action).toContainText('A thought about the garden');
  await expect(action).toContainText('On this device');
  expect(api.applied).toHaveLength(0);

  api.commandMode = 'ok';
  await context.setOffline(false);
  await expect(action).toContainText('Saved to GitHub');
  expect(api.applied.map((c) => c.type)).toEqual(['CaptureNote']);
  // Any attempt made while offline carried exactly the same bytes as the one that landed.
  expect(new Set(api.bodies).size).toBe(1);

  // The Task | Note choice is remembered.
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('button', { name: 'Note' })).toHaveAttribute('aria-pressed', 'true');
});

test('a refused completion moves back with the error and offers Retry / Export / Discard', async ({ page }) => {
  api.commandMode = { refuse: { code: 'conflict:task-changed', message: 'This task changed on another device.', retryable: false } };
  await page.goto('/');

  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();

  const row = region(page, 'Today').getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(row).toContainText('Needs attention');
  await expect(row).toContainText('This task changed on another device.');
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(0);

  const actions = region(page, 'Actions on this device');
  await expect(actions.getByRole('button', { name: 'Retry' })).toBeVisible();
  await actions.getByRole('button', { name: 'Export text' }).click();
  await expect(page.getByLabel('Exported text')).toHaveValue('- [ ] Water the plants 📅 2026-09-24');
  await page.getByRole('button', { name: 'Close' }).click();

  const attempts = api.bodies.length;
  await actions.getByRole('button', { name: 'Discard' }).click();
  await expect(actions).toHaveCount(0);
  await expect(row).not.toContainText('Needs attention');
  expect(api.bodies.length).toBe(attempts); // a terminal refusal is not retried automatically
});

test('a pending action survives a reload and is sent afterwards, byte-for-byte', async ({ page }) => {
  api.commandMode = 'unavailable';
  await page.goto('/');
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Task' }).click();
  await page.getByLabel('Task text').fill('Buy seed potatoes');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => api.bodies.length).toBeGreaterThan(0);

  await page.reload();
  await expect(region(page, 'Actions on this device').getByTestId('action')).toContainText('Buy seed potatoes');

  api.commandMode = 'ok';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(region(page, 'Actions on this device')).toContainText('Saved to GitHub');
  expect(parsed(api.bodies).map((c) => c.type)).toEqual(api.bodies.map(() => 'CaptureTask'));
  expect(new Set(api.bodies).size).toBe(1);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(region(page, 'All tasks').getByText('Buy seed potatoes')).toBeVisible();
});

test('read-only tasks have no active checkbox and show a short reason', async ({ page }) => {
  api.open = [taskView(12, 'Take out the recycling', { recurring: true, readOnlyReason: 'refused:recurring' })];
  await page.goto('/');
  const row = region(page, 'Today').getByTestId('task');
  await expect(row).toContainText('Recurring — complete in Obsidian');
  await expect(row.getByRole('button')).toHaveCount(0);
});

test('task text is rendered as text, and wikilinks as plain text', async ({ page }) => {
  api.open = [taskView(13, '<img src=x onerror="window.pwned=1"> ask [[People/Ana|Ana]] about [[Seeds]]')];
  await page.goto('/');
  await expect(region(page, 'Today')).toContainText('<img src=x onerror="window.pwned=1"> ask Ana about Seeds');
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  await expect(page.locator('main img')).toHaveCount(0);
});

test('signed out: banner, and nothing is sent', async ({ page }) => {
  api.session = 'signed-out';
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Signed out — reload to sign in');
  expect(api.bodies).toHaveLength(0);
});
