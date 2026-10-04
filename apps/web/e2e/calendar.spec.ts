import { MorningBriefResponse } from '@vault-companion/contracts';
import { expect, test } from '@playwright/test';
import { dateIn } from '../src/time.ts';
import { taskCalendarKey } from '../src/ui/calendar-sheet.ts';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

const TASK_TEXT = 'Draft quarterly notes at 14:00';

test('add: a task glyph opens the sheet, creates one event and becomes In Calendar after reload', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(3, TASK_TEXT)];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');

  await page.getByRole('button', { name: `Add to Calendar: ${TASK_TEXT}` }).click();
  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  await expect(sheet.getByLabel('Title')).toHaveValue(TASK_TEXT);
  await expect(sheet.getByLabel('Start')).toHaveValue('14:00');
  await expect(sheet.getByLabel('End')).toHaveValue('14:30');
  await expect(sheet.getByLabel('Notes')).toHaveValue(`From Vault Companion\n${TASK_TEXT}`);
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => api.calendarCreateBodies.length).toBe(1);
  const body = JSON.parse(api.calendarCreateBodies[0]!);
  expect(body).toMatchObject({ title: TASK_TEXT, type: 'none' });
  expect(body.start).toMatch(/T14:00/);
  expect(body.start).toMatch(/^2026-09-24T14:00:00/);
  expect(body.end).toMatch(/^2026-09-24T14:30:00/);
  expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.keys(api.calendarEvents)).toHaveLength(1);

  await page.reload();
  await goTo(page, 'Tasks');
  await expect(page.getByRole('button', { name: `In Calendar: ${TASK_TEXT}` })).toBeVisible();
});

test('remove: the In Calendar sheet unlinks the event and the glyph returns', async ({ page }) => {
  const api = new MockApi();
  const task = taskView(3, TASK_TEXT);
  api.open = [task];
  api.calendarLinks[taskCalendarKey(task.locator)] = 'event-7';
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');

  await page.getByRole('button', { name: `In Calendar: ${TASK_TEXT}` }).click();
  const sheet = page.getByRole('dialog', { name: 'In Calendar' });
  await sheet.getByRole('button', { name: 'Remove from Calendar' }).click();

  await expect.poll(() => api.calendarRemoveBodies.length).toBe(1);
  expect(JSON.parse(api.calendarRemoveBodies[0]!).itemKey).toBe(taskCalendarKey(task.locator));
  await expect.poll(() => Object.keys(api.calendarLinks).length).toBe(0);
  await expect(page.getByRole('button', { name: `Add to Calendar: ${TASK_TEXT}` })).toBeVisible();
});

test('double tap: the same operation id never creates a second event', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(3, TASK_TEXT)];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');

  await page.getByRole('button', { name: `Add to Calendar: ${TASK_TEXT}` }).click();
  const save = page.getByRole('dialog', { name: 'Add to Calendar' }).getByRole('button', { name: 'Save' });
  await save.click();
  await save.click({ timeout: 1_500 }).catch(() => undefined);

  await expect.poll(() => Object.keys(api.calendarEvents).length).toBe(1);
  expect(Object.keys(api.calendarEvents)).toEqual(['event-1']);
});

test('offline: the write fails inline and is never queued', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(3, TASK_TEXT)];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  await page.getByRole('button', { name: `Add to Calendar: ${TASK_TEXT}` }).click();

  api.calendarMode = 'offline';
  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect(sheet.getByRole('alert')).toContainText('offline');
  expect(Object.keys(api.calendarEvents)).toHaveLength(0);
  // The sheet stays open for a retry; nothing was put on the device queue.
  await expect(sheet).toBeVisible();
});

test('an unconfigured writer shows "Calendar writing is not set up"', async ({ page }) => {
  const api = new MockApi();
  api.open = [taskView(3, TASK_TEXT)];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  await page.getByRole('button', { name: `Add to Calendar: ${TASK_TEXT}` }).click();

  api.calendarMode = 'unavailable';
  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Calendar writing is not set up');
});

test('chips: today\u2019s free blocks pre-fill the time window', async ({ page }) => {
  const api = new MockApi();
  const today = dateIn(new Date().toISOString(), 'Europe/Copenhagen');
  api.open = [taskView(3, 'Draft quarterly notes')];
  api.morningBrief = MorningBriefResponse.parse({
    revision: 'b'.repeat(40), date: today, generatedAt: `${today}T04:31:00Z`, source: 'fallback', unavailable: [],
    brief: { source: 'fallback', dayLine: 'Today', gaps: [
      { blockIndex: 0, start: `${today}T06:00:00Z`, end: `${today}T07:00:00Z`, suggestion: 'Free' },
      { blockIndex: 1, start: `${today}T09:00:00Z`, end: `${today}T09:30:00Z`, suggestion: 'Free' },
    ], todos: [] },
  });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  await page.getByRole('button', { name: 'Add to Calendar: Draft quarterly notes' }).click();

  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  const chips = sheet.getByRole('group', { name: 'Free blocks today' });
  await expect(chips.getByRole('button')).toHaveCount(2);
  await expect(sheet.getByLabel('All day')).toBeChecked();
  await chips.getByRole('button').first().click();
  await expect(sheet.getByLabel('All day')).not.toBeChecked();
  await expect(sheet.getByLabel('Start')).toHaveValue(/^\d{2}:\d{2}$/);
  await expect(sheet.getByLabel('End')).toHaveValue(/^\d{2}:\d{2}$/);
});

test('an Active Work item has its own glyph and links with an active: key', async ({ page }) => {
  const api = new MockApi();
  api.activeWork = '## Now';
  api.activeWorkItems = [{
    name: 'Garden plan', outcome: null, next: 'Order seeds', review: '2026-09-24', link: null, needsReview: false,
    locator: { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 3,
      lineText: '- [ ] **Garden plan:** Next: Order seeds \u23f3 2026-09-24', occurrencesAtRead: 1 },
  }];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');

  const card = page.getByRole('region', { name: 'Active work', exact: true });
  await card.getByRole('button', { name: 'Add to Calendar: Garden plan' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  await expect(sheet.getByLabel('Title')).toHaveValue('Garden plan');
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => api.calendarCreateBodies.length).toBe(1);
  const body = JSON.parse(api.calendarCreateBodies[0]!);
  expect(body.itemKey.startsWith('active:')).toBe(true);
  expect(body.itemKey.length).toBeLessThanOrEqual(512);
  expect(body.date).toBe('2026-09-24');
});
