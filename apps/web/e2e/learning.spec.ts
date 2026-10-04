import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

async function openLearning(page: Page) {
  await goTo(page, 'Log');
  await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Learning', exact: true }).click();
  return page.getByRole('region', { name: 'Learning sessions' });
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Add session', exact: true }).click();
  return page.getByRole('dialog', { name: 'Add session', exact: true });
}

test('kind chips come from the read; date plus kind is a two-tap save; Undo restores the list', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const list = await openLearning(page);
  await expect(list).toContainText('No sessions yet');

  const sheet = await openSheet(page);
  await expect(sheet.getByLabel('Date', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/);
  // Kinds are the mock's read, not a list in the app: a kind the read does not hold has no chip.
  await expect(sheet.getByRole('button', { name: 'Dictation', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Gym', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Dictation', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(list.getByTestId('learning-row')).toHaveCount(1);
  await expect(list).toContainText('Dictation');
  await expect(list).toContainText('no minutes');
  const action = page.getByTestId('action').filter({ hasText: 'Learning session' });
  await expect(action).toBeVisible();
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(list.getByTestId('learning-row')).toHaveCount(0);
  expect(api.applied.map((c) => c.type)).toEqual(['LogLearning', 'UndoLogLearning']);
});

test('a paste line fills the sheet; a refused paste says so and changes nothing', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await openLearning(page);
  const sheet = await openSheet(page);
  await sheet.getByLabel('Paste line', { exact: true }).fill('LG | dictation | 2026-10-03 | min 12 | score 3/5 | acc 8 | topic: weather report');
  await expect(sheet.getByLabel('Date', { exact: true })).toHaveValue('2026-10-03');
  await expect(sheet.getByLabel('Minutes (optional)', { exact: true })).toHaveValue('12');
  await expect(sheet.getByLabel('Score (optional)', { exact: true })).toHaveValue('3/5');
  await expect(sheet.getByLabel('Detail (optional)', { exact: true })).toHaveValue('acc 8');
  await expect(sheet.getByLabel('Topic (optional)', { exact: true })).toHaveValue('weather report');

  await sheet.getByLabel('Paste line', { exact: true }).fill('not a learning line');
  await expect(sheet.getByRole('alert')).toContainText(/does not match/i);
  await expect(sheet.getByLabel('Date', { exact: true })).toHaveValue('2026-10-03');
  await expect(sheet.getByLabel('Minutes (optional)', { exact: true })).toHaveValue('12');
});

test('sessions per week and a per-kind score trend render without any streak or target text', async ({ page }) => {
  const api = new MockApi();
  api.learningRows = [
    { date: '2026-09-20', kind: 'dictation', minutes: '15', score: '4/5', detail: 'acc 9', topic: 'weather report', note: '' },
    { date: '2026-09-14', kind: 'dictation', minutes: '10', score: '3/5', detail: 'acc 7', topic: 'verbs', note: '' },
  ];
  await api.install(page);
  await page.goto('/');
  const list = await openLearning(page);
  await expect(list).toContainText('Sessions per week');
  await expect(list.getByTestId('learning-trend')).toHaveCount(1);
  await expect(list.getByTestId('learning-row')).toHaveCount(2);
  await expect(list).not.toContainText(/streak|target|goal|missed/i);
});

test('an absent or refused read is reported honestly, never as rows', async ({ page }) => {
  const api = new MockApi();
  api.learningMode = 'absent';
  await api.install(page);
  await page.goto('/');
  const list = await openLearning(page);
  await expect(list).toContainText('Learning Gym Log not found');
  await expect(list.getByTestId('learning-row')).toHaveCount(0);

  api.learningMode = 'refused';
  await page.reload();
  const refused = await openLearning(page);
  await expect(refused).toContainText('Learning Gym Log table not found');
  await expect(refused.getByTestId('learning-row')).toHaveCount(0);
});

test('a conflict:learning-changed action shows the Training-style message', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await openLearning(page);
  api.commandMode = { refuse: { code: 'conflict:learning-changed', message: 'That session changed in Obsidian.', retryable: false } };
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Dictation', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('action')).toContainText('That session changed in Obsidian — refresh and edit again.');
});
