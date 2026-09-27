import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

for (const state of ['waiting', 'installed', 'installing', 'first-install'] as const) {
  test(`update banner retains ${state} registration readiness`, async ({ page }) => {
    const api = new MockApi();
    await api.install(page);
    await page.addInitScript((state) => {
      const worker = Object.assign(new EventTarget(), { state: state === 'installing' ? 'installing' : 'installed' });
      const registration = Object.assign(new EventTarget(), {
        waiting: state === 'waiting' ? worker : null,
        installing: state === 'waiting' ? null : worker,
      });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
        controller: state === 'first-install' ? null : {},
        register: () => Promise.resolve(registration),
      } });
      Object.assign(window, { finishUpdate: () => { worker.state = 'installed'; worker.dispatchEvent(new Event('statechange')); } });
    }, state);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Capture', exact: true })).toBeVisible();
    const banner = page.getByRole('button', { name: 'New version — tap to reload' });
    if (state === 'first-install') {
      await expect(banner).toHaveCount(0);
    } else {
      if (state === 'installing') {
        await expect(banner).toHaveCount(0);
        await page.evaluate(() => (window as unknown as { finishUpdate: () => void }).finishUpdate());
      }
      await expect(banner).toBeVisible();
    }
  });
}

test('needs-review Done → queued Undo, then capture Active Work request body', async ({ page }) => {
  const api = new MockApi();
  api.activeWork = '## Now';
  api.unknownNowLines = ['A hand-edited reminder'];
  api.activeWorkItems = [{
    name: 'Garden plan', outcome: null, next: 'Order seeds', review: '2026-09-01', link: null, needsReview: true,
    locator: { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 3,
      lineText: '- [ ] **Garden plan:** Next: Order seeds ⏳ 2026-09-01', occurrencesAtRead: 1 },
  }];
  const original = structuredClone(api.activeWorkItems);
  api.commandMode = 'hold';
  await api.install(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Active work', exact: true });
  await expect(card.getByText('Needs review', { exact: true })).toBeVisible();
  await expect(card).toContainText('edited in Obsidian');
  await expect(card).toContainText('A hand-edited reminder');
  await expect(card.getByRole('button', { name: 'Keep: Garden plan', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Done: Garden plan', exact: true }).click();
  await expect.poll(() => api.heldCount).toBe(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(api.bodies).toHaveLength(1);
  api.release();
  await expect.poll(() => api.applied.map(c => c.type)).toEqual(['ReviewActiveWork', 'UndoActiveWork']);
  const done = JSON.parse(api.bodies[0]!);
  const undo = JSON.parse(api.bodies[1]!);
  expect(done.payload.action).toBe('done');
  expect(undo.payload.target).toEqual(done);
  expect(undo.payload.targetCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(api.activeWorkItems).toEqual(original);
  await expect(card.getByRole('button', { name: 'Edit: Garden plan', exact: true })).toBeEnabled();
  await expect(page.getByText('reaches Obsidian at your next desktop sync').first()).toBeVisible();

  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Capture', exact: true });
  await sheet.getByRole('button', { name: 'Active Work', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(sheet.getByLabel('Review date', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  await sheet.getByLabel('Name', { exact: true }).fill('  Bike repair  ');
  await sheet.getByLabel('Next action', { exact: true }).fill(' Call the shop ');
  await sheet.getByLabel('Review date', { exact: true }).fill('2026-10-10');
  await sheet.getByLabel('Link', { exact: true }).fill('[[Bike Plan]]');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.applied.length).toBe(3);
  expect(JSON.parse(api.bodies[2]!)).toMatchObject({ type: 'CaptureActiveWork',
    payload: { name: 'Bike repair', next: 'Call the shop', review: '2026-10-10', link: '[[Bike Plan]]' } });
  await expect(card.getByRole('button', { name: 'Edit: Bike repair' })).toBeVisible();

  await card.getByRole('button', { name: 'Edit: Bike repair' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Active Work', exact: true });
  await edit.getByLabel('Name', { exact: true }).fill(' Bike service ');
  await edit.getByRole('button', { name: 'Clear review date' }).click();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.applied.length).toBe(4);
  expect(JSON.parse(api.bodies[3]!).payload.changes).toEqual({ name: 'Bike service', review: null });
});

test('C2: an item not yet due can be finished early — Done, Park, Drop shown, Keep hidden', async ({ page }) => {
  const api = new MockApi();
  api.activeWork = '## Now';
  api.activeWorkItems = [{
    name: 'Bike repair', outcome: null, next: 'Call the shop', review: '2099-01-01', link: null, needsReview: false,
    locator: { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 3,
      lineText: '- [ ] **Bike repair:** Next: Call the shop ⏳ 2099-01-01', occurrencesAtRead: 1 },
  }];
  api.commandMode = 'hold';
  await api.install(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Active work', exact: true });
  await expect(card.getByText('Needs review', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Keep: Bike repair', exact: true })).toHaveCount(0);
  for (const a of ['Park', 'Drop']) await expect(card.getByRole('button', { name: a + ': Bike repair', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Done: Bike repair', exact: true }).click();
  await expect.poll(() => api.heldCount).toBe(1);
  expect(JSON.parse(api.bodies[0]!).payload).toMatchObject({ action: 'done', item: { lineIndex: 3 } });
  api.release();
});
