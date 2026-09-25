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

test('a second tab never re-sends a completion in flight in the first, and Undo is a real command (A3)', async ({ page, context }) => {
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();

  api.commandMode = 'hold';
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect.poll(() => api.heldCount).toBe(1);

  // Second tab over the same IndexedDB database, while the first tab's request is still out.
  const second = await context.newPage();
  await api.install(second);
  await second.goto('/');
  await expect(region(second, 'Done today').getByText('Water the plants')).toBeVisible();
  await second.evaluate(() => window.dispatchEvent(new Event('online')));

  // The completion may already have applied: Undo cannot be a local cancellation.
  await page.getByRole('button', { name: 'Undo' }).click();
  await second.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(region(second, 'Actions on this device').getByTestId('action')).toHaveCount(2);
  expect(api.bodies).toHaveLength(1); // neither tab sent anything else while the completion was in flight

  api.release();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['CompleteTask', 'UndoCompleteTask']);
  expect(parsed(api.bodies).filter((c) => c.type === 'CompleteTask')).toHaveLength(1);

  await second.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(region(second, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
});

test('open a linked note from a task: read-only, sanitised, and nothing about it stored on the device', async ({ page }) => {
  api.open = [taskView(14, 'Prepare [[Projects/Garden/Plan|the garden plan]] and [[Missing]]', { links: ['Projects/Garden/Plan', 'Missing'] })];
  api.notes.set('Projects/Garden/Plan', {
    path: 'Projects/Garden/Plan.md',
    markdown: [
      '# Beds',
      '',
      'Sow **carrots** in row 3. See [[Seeds]] and [the almanac](https://example.com/almanac).',
      '',
      '<img src=x onerror="window.pwned=1"> [bad](javascript:window.pwned=2) ![x](javascript:window.pwned=3)',
      '',
      '<svg onload="window.pwned=4"></svg>',
    ].join('\n'),
  });
  await page.goto('/');

  await page.getByRole('button', { name: 'Open note: the garden plan' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(dialog).toContainText('Read-only');
  const body = dialog.getByTestId('note-body');
  await expect(body.getByRole('heading', { name: 'Beds' })).toBeVisible();
  await expect(body.locator('strong')).toHaveText('carrots');
  await expect(body.locator('.wikilink')).toHaveText('Seeds');
  const almanac = body.getByRole('link', { name: 'the almanac' });
  await expect(almanac).toHaveAttribute('href', 'https://example.com/almanac');
  await expect(almanac).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(body.getByRole('link')).toHaveCount(1);
  await expect(body.locator('img, svg, script')).toHaveCount(0);
  await expect(body).toContainText('<img src=x onerror="window.pwned=1">');
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // The request named the task and link index only; task text never travelled in the URL.
  expect(api.noteRequests).toHaveLength(1);
  expect(api.noteRequests[0]!.req.linkIndex).toBe(0);
  expect(api.noteRequests[0]!.url).not.toContain('garden');
  expect(new URL(api.noteRequests[0]!.url).search).toBe('');

  // No note content in IndexedDB or Cache Storage.
  const stored = await page.evaluate(async () => {
    const dump: string[] = [];
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const name of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((resolve, reject) => {
          const r = db.transaction(name).objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        dump.push(JSON.stringify(all));
      }
      db.close();
    }
    for (const key of await caches.keys()) {
      for (const req of await (await caches.open(key)).keys()) dump.push(req.url);
    }
    return dump.join('\n');
  });
  expect(stored).not.toContain('carrots');
  expect(stored).not.toContain('linked-note');

  await page.getByRole('button', { name: 'Back to tasks' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open note: Missing' }).click();
  await expect(page.getByRole('dialog')).toContainText('No note with this name was found.');
});

test('Active work card: above Today, sanitised, collapse remembered, nothing stored', async ({ page }) => {
  api.activeWork = [
    '# This week',
    '',
    '- Finish the **garden** plan with [[Projects/Garden|the garden]]',
    '',
    '<img src=x onerror="window.pwned=1"> [bad](javascript:window.pwned=2)',
  ].join('\n');
  await page.goto('/');

  const card = region(page, 'Active work');
  const body = card.getByTestId('active-work-body');
  await expect(body.locator('strong')).toHaveText('garden');
  await expect(body.locator('.wikilink')).toHaveText('the garden');
  await expect(body.locator('a, img')).toHaveCount(0);
  await expect(body).toContainText('<img src=x onerror="window.pwned=1">');
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // Above Today in document order.
  const above = await page.evaluate(() => {
    const cardEl = document.querySelector('section[aria-label="Active work"]')!;
    const today = document.querySelector('section[aria-label="Today"]')!;
    return Boolean(cardEl.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(above).toBe(true);

  await card.getByRole('button', { name: 'Active work' }).click();
  await expect(body).toHaveCount(0);
  await page.reload();
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Active work' })).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByTestId('active-work-body')).toHaveCount(0);
  await card.getByRole('button', { name: 'Active work' }).click();
  await expect(card.getByTestId('active-work-body')).toContainText('This week');

  const stored = await page.evaluate(async () => {
    const dump: string[] = [];
    for (const info of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const name of db.objectStoreNames) {
        const all = await new Promise<unknown[]>((resolve, reject) => {
          const r = db.transaction(name).objectStore(name).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        dump.push(JSON.stringify(all));
      }
      db.close();
    }
    for (const key of await caches.keys()) for (const req of await (await caches.open(key)).keys()) dump.push(req.url);
    dump.push(JSON.stringify({ ...localStorage }));
    return dump.join('\n');
  });
  expect(stored).not.toContain('garden');
  expect(stored).not.toContain('active-work');
});

test('Active work failures are quiet: the task lists still render; an absent file shows no card', async ({ page }) => {
  api.activeWork = 'error';
  await page.goto('/');
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Active work')).toContainText('Not available right now.');
  await expect(page.getByRole('alert')).toHaveCount(0);

  api.activeWork = null;
  await page.reload();
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Active work')).toHaveCount(0);
});
