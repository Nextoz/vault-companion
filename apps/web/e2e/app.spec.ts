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
const toast = (page: Page) => page.locator('.toast');

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

  await toast(page).getByRole('button', { name: 'Undo' }).click();
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

test('a changed-task refusal moves back with the error and offers Refresh / Copy / Discard, never Retry', async ({ page }) => {
  api.commandMode = { refuse: { code: 'conflict:task-changed', message: 'This task changed on another device.', retryable: false } };
  await page.goto('/');

  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();

  const row = region(page, 'Today').getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(row).toContainText('Needs attention');
  await expect(row).toContainText('This task changed on another device.');
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(0);

  const actions = region(page, 'Actions on this device');
  await expect(actions).toContainText('This task changed on another device.');
  await expect(actions.getByRole('button', { name: 'Refresh tasks' })).toBeVisible();
  // The same bytes would be refused again: no Retry for a non-retryable refusal (P4-B).
  await expect(actions.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  await actions.getByRole('button', { name: 'Copy text' }).click();
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

// ---- P4-B: client correctness -----------------------------------------------------------------------------------

test('two identical open tasks: completing one leaves the other, which can then be completed too', async ({ page }) => {
  api.open = [taskView(10, 'Water the plants'), taskView(12, 'Water the plants'), taskView(14, 'Call the bike shop')];
  await page.goto('/');
  const today = region(page, 'Today');
  const twins = today.getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(twins).toHaveCount(2);

  // Pending on the device, then reloaded: the other twin never disappears.
  api.commandMode = 'offline';
  await twins.first().getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect(twins).toHaveCount(1);
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(1);
  await expect.poll(() => api.bodies.length).toBeGreaterThan(0);
  await page.reload();
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(1);
  await expect(twins).toHaveCount(1);

  api.commandMode = 'ok';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => api.applied.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(region(page, 'Done today').getByText('Saved to GitHub')).toBeVisible();
  await expect(twins).toHaveCount(1);

  // The remaining twin is still completable, and its completion names its own line.
  await twins.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect.poll(() => api.applied.length).toBe(2);
  await expect(twins).toHaveCount(0);
  const lines = api.applied.map((c) => (c.type === 'CompleteTask' ? c.payload.task.lineIndex : -1));
  expect(lines).toEqual([10, 12]);
  await expect(region(page, 'Done today').getByTestId('task')).toHaveCount(2);
});

test('a stale read with shifted identical lines shows the pending completion on its own row, hiding no task', async ({ page }) => {
  api.open = [taskView(10, 'Water the plants'), taskView(12, 'Water the plants')];
  await page.goto('/');
  const twins = region(page, 'Today').getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(twins).toHaveCount(2);

  api.commandMode = 'offline';
  await twins.first().getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect(twins).toHaveCount(1);

  // A desktop edit inserted a line above both: new blob, both twins one line down.
  api.open = [taskView(11, 'Water the plants'), taskView(13, 'Water the plants')];
  api.blobSha = '9'.repeat(40);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(twins).toHaveCount(2);
  await expect(region(page, 'Done today').getByTestId('task')).toContainText('On this device');
});

test('Undo from Done today after the toast expired sends exactly one valid UndoCompleteTask', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(toast(page)).toBeVisible();
  await page.clock.fastForward(9_000);
  await expect(toast(page)).toHaveCount(0);

  const done = region(page, 'Done today').getByTestId('task').filter({ hasText: 'Water the plants' });
  await expect(done).toContainText('Saved to GitHub');
  const undo = done.getByRole('button', { name: 'Undo: Water the plants' });
  await undo.click();
  await expect.poll(() => api.applied.length).toBe(2);

  const sent = parsed(api.bodies);
  const undos = sent.filter((c) => c.type === 'UndoCompleteTask');
  expect(undos).toHaveLength(1);
  // It carries the stored completion envelope verbatim.
  expect(undos[0]?.type === 'UndoCompleteTask' && undos[0].payload.target).toEqual(sent[0]);
  await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  await expect(region(page, 'Done today').getByText('Water the plants')).toHaveCount(0);
});

test('no Undo in Done today for a completion this device did not make', async ({ page }) => {
  api.doneToday = [{ ...taskView(30, 'Sweep the porch'), status: 'done', section: 'done', done: '2026-09-24' }];
  await page.goto('/');
  const done = region(page, 'Done today').getByTestId('task');
  await expect(done).toContainText('Sweep the porch');
  await expect(done.getByRole('button')).toHaveCount(0);
});

test('a conflict: Refresh tasks, then complete the current row', async ({ page }) => {
  api.commandMode = { refuse: { code: 'conflict:task-changed', message: 'Changed.', retryable: false } };
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  const actions = region(page, 'Actions on this device');
  await expect(actions).toContainText('This task changed on another device.');

  // The desktop had edited the line; the refreshed read shows the current one.
  api.commandMode = 'ok';
  api.open = [taskView(10, 'Water the plants today'), taskView(11, 'Call the bike shop')];
  api.blobSha = '9'.repeat(40);
  await actions.getByRole('button', { name: 'Refresh tasks' }).click();
  await region(page, 'Today').getByRole('button', { name: 'Complete: Water the plants today' }).click();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['CompleteTask']);
  await expect(region(page, 'Done today').getByText('Water the plants today')).toBeVisible();
});

for (const [what, set] of [
  ['session read fails (5xx)', () => (api.sessionMode = 'error')],
  ['session read offline', () => (api.sessionMode = 'offline')],
  ['task read fails (5xx)', () => (api.tasksMode = 'error')],
  ['task read offline', () => (api.tasksMode = 'offline')],
] as const) {
  test(`${what}: "Couldn't reach your vault" with Try again, which recovers`, async ({ page }) => {
    set();
    await page.goto('/');
    const banner = page.getByRole('status').filter({ hasText: "Couldn't reach your vault" });
    await expect(banner).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0);

    api.sessionMode = 'ok';
    api.tasksMode = 'ok';
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
}

for (const which of ['session', 'tasks'] as const) {
  test(`a ${which} read that never answers is given up after 10 s`, async ({ page }) => {
    await page.clock.install();
    if (which === 'session') api.sessionMode = 'hang';
    else api.tasksMode = 'hang';
    const hung = page.waitForRequest(which === 'session' ? '**/api/session' : '**/api/tasks**');
    await page.goto('/');
    await hung;
    await expect(page.getByText('Loading…')).toBeVisible();
    await page.clock.fastForward(10_000);
    const banner = page.getByRole('status').filter({ hasText: "Couldn't reach your vault" });
    await expect(banner).toBeVisible();

    api.sessionMode = 'ok';
    api.tasksMode = 'ok';
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(region(page, 'Today').getByText('Water the plants')).toBeVisible();
  });
}

test('a sync conflict in the task list: banner first, no task writes, notes still work', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(region(page, 'Done today').getByText('Saved to GitHub')).toBeVisible();

  // The desktop committed a conflict: the read lists both sides of a conflicted line, plus a done copy.
  api.writeBlock = { code: 'refused:vault-conflict', message: 'File contains Git conflict markers.', retryable: false };
  api.open = [taskView(10, 'Call the bike shop'), taskView(12, 'Call the bike shop at noon')];
  api.doneToday.push({ ...taskView(20, 'Call the bike shop'), status: 'done', section: 'done', done: '2026-09-24' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(page.getByRole('alert').first()).toContainText(
    'Your task list has a sync conflict — resolve it in Obsidian on your computer',
  );
  await expect(page.getByText('may include both sides of the conflict')).toBeVisible();
  await expect(region(page, 'Today').getByTestId('task')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Complete:/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Undo/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Capture' }).click();
  await expect(page.getByRole('button', { name: 'Task', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Note', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Note text').fill('A synthetic thought');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['CompleteTask', 'CaptureNote']);
});

test('Today comes first; Overdue is a collapsed group below it, with its count, that expands (ADR-0012)', async ({ page }) => {
  api.open = [
    taskView(10, 'Water the plants'),
    taskView(11, 'Renew the library card', { due: '2026-09-20' }),
    taskView(12, 'Return the drill', { due: '2026-09-22' }),
  ];
  await page.goto('/');
  const groups = page.locator('main section.group');
  await expect(groups.first()).toHaveAttribute('aria-label', 'Today');
  await expect(groups.nth(1)).toHaveAttribute('aria-label', 'Overdue');

  const overdue = region(page, 'Overdue');
  const toggle = overdue.getByRole('button', { name: '2 overdue' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(overdue.getByTestId('task')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(overdue.getByTestId('task')).toHaveCount(2);
  await overdue.getByRole('button', { name: 'Complete: Return the drill' }).click();
  await expect.poll(() => api.applied.length).toBe(1);
  await expect(overdue.getByRole('button', { name: '1 overdue' })).toBeVisible();
});
