import { expect, test, type Page } from '@playwright/test';
import { Command } from '@vault-companion/contracts';
import { MockApi, taskView } from './mock-api.ts';

let api: MockApi;

test.beforeEach(async ({ page }) => {
  api = new MockApi();
  api.open = [taskView(10, 'Water the plants')];
  await api.install(page);
});

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

/** The draft store as IndexedDB has it now (the test's own synthetic text only). */
const storedDrafts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open('vault-companion');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('drafts', 'readonly').objectStore('drafts').getAll();
          req.onsuccess = () => {
            open.result.close();
            resolve(req.result);
          };
          req.onerror = () => reject(req.error);
        };
      }),
  );

test('an unsaved capture survives a reload, is restored with its type, and is sent exactly once', async ({ page }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();

  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Note' }).click();
  await page.getByLabel('Note text').fill('A synthetic half-finished thought');
  // The debounced write; then leave without saving.
  await expect.poll(() => storedDrafts(page)).toHaveLength(1);
  await page.reload();
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  expect(api.bodies).toHaveLength(0); // typing and reloading sent nothing

  // The capture type preference says Task; the restored draft says Note.
  await page.evaluate(() => localStorage.setItem('vc.captureKind', 'task'));
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('button', { name: 'Note' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Note text')).toHaveValue('A synthetic half-finished thought');
  expect(api.bodies).toHaveLength(0); // restoring sent nothing

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(region(page, 'Actions on this device')).toContainText('Saved to GitHub');
  expect(api.bodies).toHaveLength(1);
  expect(api.applied.map((c) => c.type)).toEqual(['CaptureNote']);
  expect(Command.parse(JSON.parse(api.bodies[0] ?? '')).payload).toMatchObject({ text: 'A synthetic half-finished thought' });
  expect(await storedDrafts(page)).toEqual([]);

  // The draft is gone: reopening starts empty, and a reload re-sends nothing.
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByLabel(/^(Task|Note) text$/)).toHaveValue('');
  await page.reload();
  await expect(region(page, 'Actions on this device')).toContainText('Saved to GitHub');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByLabel(/^(Task|Note) text$/)).toHaveValue('');
  expect(api.bodies).toHaveLength(1);
  expect(api.applied).toHaveLength(1);
});

test('closing keeps the draft; Discard draft removes it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Task' }).click();
  await page.getByLabel('Task text').fill('Synthetic task draft');
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByLabel('Task text')).toHaveValue('Synthetic task draft');
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByLabel('Task text')).toHaveValue('');
  await expect.poll(() => storedDrafts(page)).toEqual([]);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByLabel('Task text')).toHaveValue('');
  expect(api.bodies).toHaveLength(0);
});

test('two windows with the same draft: exactly one Save sends it, and the other cannot bring it back', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Note' }).click();
  await page.getByLabel('Note text').fill('A synthetic shared thought');
  await expect.poll(() => storedDrafts(page)).toHaveLength(1);

  // A second window over the same IndexedDB database restores the same draft.
  const second = await context.newPage();
  await api.install(second);
  await second.goto('/');
  await expect(region(second, 'Today').getByText('Water the plants')).toBeVisible();
  await second.getByRole('button', { name: 'Capture' }).click();
  await expect(second.getByLabel('Note text')).toHaveValue('A synthetic shared thought');

  await second.getByRole('button', { name: 'Save' }).click();
  await expect(region(second, 'Actions on this device')).toContainText('Saved to GitHub');
  expect(await storedDrafts(page)).toEqual([]);

  // The first window still shows the same draft: its Save is refused by the store, and nothing is sent.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('This draft was saved or changed in another window')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Typing on, the debounce, hiding and closing the window do not recreate it.
  await page.getByLabel('Note text').fill('A synthetic shared thought, continued');
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.getByRole('button', { name: 'Close' }).click();
  expect(await storedDrafts(page)).toEqual([]);

  await page.reload();
  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByLabel(/^(Task|Note) text$/)).toHaveValue('');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await second.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(region(page, 'Actions on this device')).toContainText('Saved to GitHub');
  expect(api.bodies).toHaveLength(1);
  expect(api.applied.map((c) => c.type)).toEqual(['CaptureNote']);
});
