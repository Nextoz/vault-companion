// Redesign R2: the task done moment and drag-to-dismiss on sheets, in the real WebKit build.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

let api: MockApi;

test.beforeEach(async ({ page }) => {
  // Reads are dated 2026-09-24 (Copenhagen): completions must be made that day to stay in Done today (app.spec.ts).
  await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });
  api = new MockApi();
  api.open = [taskView(10, 'Water the plants'), taskView(11, 'Call the bike shop')];
  await api.install(page);
});

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('completing a task plays the done moment in place, then the row ends in Done today', async ({ page }) => {
  await page.goto('/');
  await goTo(page, 'Tasks');
  const today = region(page, 'Today');
  await expect(today.getByText('Water the plants')).toBeVisible();

  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();

  // The write is queued at once; the row holds, struck through, before it folds away.
  await expect(today.locator('.task-leaving .task-strike')).toHaveText('Water the plants');
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(today.getByText('Water the plants')).toHaveCount(0);
  await expect(today.getByText('Call the bike shop')).toBeVisible();
  const done = region(page, 'Done today').getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(done).toBeVisible();
  await expect(done.locator('.check-on .check-tick')).toHaveCount(1);
  expect(api.applied).toHaveLength(1); // the hold and fold never complete the task twice
  // Unfolded to its full height (the arrival animation has finished and left no clipping behind).
  await expect.poll(async () => (await done.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

/** Drags from the sheet header's title down by `dy` px, slowly (no flick): `steps` moves `pause` ms apart. */
async function dragHeader(page: Page, sheet: Locator, dy: number, steps = 12, pause = 40) {
  const title = sheet.locator('.sheet-header h2');
  const box = await title.boundingBox();
  if (!box) throw new Error('sheet header not laid out');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y + (dy * i) / steps);
    await page.waitForTimeout(pause);
  }
  await page.waitForTimeout(150); // hold still: the release carries no velocity
  await page.mouse.up();
}

async function openEditSheet(page: Page): Promise<Locator> {
  await page.goto('/');
  await goTo(page, 'Tasks');
  await page.getByRole('button', { name: 'Edit: Water the plants', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit task' });
  await expect(sheet).toBeVisible();
  await expect.poll(() => sheet.evaluate((el) => el.getAnimations().length)).toBe(0); // slide-in finished
  return sheet;
}

test('dragging the sheet header down past a quarter of its height dismisses the sheet', async ({ page }) => {
  const sheet = await openEditSheet(page);
  const height = (await sheet.boundingBox())?.height ?? 0;
  expect(height).toBeGreaterThan(100);

  await dragHeader(page, sheet, height * 0.4);

  await expect(sheet).toHaveCount(0);
  expect(api.bodies).toHaveLength(0); // dismissing is not saving
});

test('a short drag on the header springs the sheet back and leaves it open', async ({ page }) => {
  const sheet = await openEditSheet(page);
  const rest = (await sheet.boundingBox())?.y ?? 0;

  await dragHeader(page, sheet, 40, 8);

  await expect.poll(() => sheet.evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect(sheet).toBeVisible();
  expect(Math.abs(((await sheet.boundingBox())?.y ?? 0) - rest)).toBeLessThan(1);
  // Close still works afterwards: it slides the sheet out, then closes it.
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
});

test('under reduced motion, tapping the sheet header title plays no animation (no blink)', async ({ page }) => {
  const sheet = await openEditSheet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Count every animation started on the sheet or its backdrop from here on.
  await page.evaluate(() => {
    const original = Element.prototype.animate;
    const w = window as unknown as { sheetAnimations: number };
    w.sheetAnimations = 0;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      if (this.closest('.sheet-backdrop')) w.sheetAnimations++;
      return original.apply(this, args);
    };
  });
  await sheet.locator('.sheet-header h2').click();
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sheetAnimations: number }).sheetAnimations)).toBe(0);
  expect(await sheet.evaluate((el) => el.parentElement?.getAnimations().length ?? -1)).toBe(0);
});