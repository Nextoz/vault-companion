import { expect, test, type Page } from '@playwright/test';
import type { BookView } from '@vault-companion/contracts';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

async function openReading(page: Page) {
  await goTo(page, 'Log');
  await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Reading', exact: true }).click();
  return page.getByRole('region', { name: 'Reading' });
}

const book = (over: Partial<BookView> = {}): BookView => ({
  title: 'Synthetic Book', author: 'A. Author', totalPages: 200, currentPage: 40,
  status: 'reading', lastRead: '2026-10-01', reflections: [], ...over,
});

test('an empty shelf starts a book from the sheet; Undo takes it away', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  await expect(region).toContainText('No books yet');

  await region.getByRole('button', { name: 'Start a book', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a book', exact: true });
  await sheet.getByLabel('Title', { exact: true }).fill('Synthetic Book');
  await sheet.getByLabel('Author', { exact: true }).fill('A. Author');
  await sheet.getByLabel('Total pages', { exact: true }).fill('200');
  await sheet.getByRole('button', { name: 'Start book', exact: true }).click();

  const current = region.getByTestId('reading-current');
  await expect(current).toContainText('Synthetic Book');
  await expect(current).toContainText('page 0 of 200');
  const action = page.getByTestId('action').filter({ hasText: 'Start book' });
  await expect(action).toBeVisible();
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(region.getByTestId('reading-current')).toHaveCount(0);
  expect(api.applied.map((c) => c.type)).toEqual(['StartBook', 'UndoStartBook']);
});

test('the reading book leads, a done book is listed below and shows Finished when tapped', async ({ page }) => {
  const api = new MockApi();
  api.books = [
    book({ title: 'Finished One', status: 'done', lastRead: '2026-10-09', currentPage: 200, totalPages: 200 }),
    book({ title: 'Reading One', lastRead: '2026-10-05', currentPage: 40 }),
  ];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  const current = region.getByTestId('reading-current');
  await expect(current).toContainText('Reading One');
  await expect(current).not.toContainText('Finished One');
  await expect(current).not.toContainText('Finished');

  await region.getByRole('button', { name: /Finished One/ }).click();
  await expect(current).toContainText('Finished One');
  await expect(current).toContainText('Finished');
  await expect(current.getByRole('button', { name: /Mark done/i })).toHaveCount(0);
});

test('a lower page is blocked on the device in plain words, and Save stays disabled', async ({ page }) => {
  const api = new MockApi();
  api.books = [book({ title: 'Reading One', currentPage: 40 })];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  await region.getByRole('button', { name: 'Log pages', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Log pages', exact: true });
  await expect(sheet.getByLabel('Page', { exact: true })).toHaveValue('40');
  await expect(sheet.getByLabel('Date', { exact: true })).toHaveValue(/\d{4}-\d{2}-\d{2}/);

  await sheet.getByLabel('Page', { exact: true }).fill('12');
  await expect(sheet.getByRole('alert')).toContainText(/before where you are/);
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect(api.bodies).toHaveLength(0);
});

test('the + on the Reading view logs the next page and updates the card', async ({ page }) => {
  const api = new MockApi();
  api.books = [book({ title: 'Reading One', currentPage: 40 })];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  await page.getByRole('button', { name: 'Log reading', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Log pages', exact: true });
  await sheet.getByLabel('Page', { exact: true }).fill('55');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(region.getByTestId('reading-current')).toContainText('page 55 of 200');
  expect(api.applied.map((c) => c.type)).toEqual(['LogReading']);
});

test('a server page refusal is shown in plain words', async ({ page }) => {
  const api = new MockApi();
  api.books = [book({ title: 'Reading One', currentPage: 40 })];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  api.commandMode = { refuse: { code: 'refused:book-page-invalid', message: 'That page is before where you are now.', retryable: false } };
  await region.getByRole('button', { name: 'Log pages', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Log pages', exact: true });
  await sheet.getByLabel('Page', { exact: true }).fill('55');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('action')).toContainText('That page is before where you are now.');
});

test('Reflect waits for text, keeps its draft on close, and two same-day reflections are two entries', async ({ page }) => {
  const api = new MockApi();
  api.books = [book({ title: 'Reading One' })];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);

  await region.getByRole('button', { name: 'Reflect', exact: true }).click();
  let sheet = page.getByRole('dialog', { name: 'Reflect', exact: true });
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await sheet.getByLabel('What stayed with me?', { exact: true }).fill('   ');
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

  await sheet.getByLabel('What stayed with me?', { exact: true }).fill('Kept while I close.');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await region.getByRole('button', { name: 'Reflect', exact: true }).click();
  sheet = page.getByRole('dialog', { name: 'Reflect', exact: true });
  await expect(sheet.getByRole('textbox', { name: /What stayed with me/ }).first()).toHaveValue('Kept while I close.');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(region.getByTestId('reading-reflection')).toHaveCount(1);
  await expect(region.getByTestId('reading-reflection').first()).toContainText('Kept while I close.');

  await region.getByRole('button', { name: 'Reflect', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reflect', exact: true }).getByLabel('What stayed with me?', { exact: true }).fill('Another synthetic thought.');
  await page.getByRole('dialog', { name: 'Reflect', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(region.getByTestId('reading-reflection')).toHaveCount(2);
  expect(api.applied.filter((c) => c.type === 'SaveReflection')).toHaveLength(2);
});

test('a conflict:book-changed action shows the Training-style message', async ({ page }) => {
  const api = new MockApi();
  api.books = [book({ title: 'Reading One' })];
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  api.commandMode = { refuse: { code: 'conflict:book-changed', message: 'That book changed in Obsidian.', retryable: false } };
  await region.getByRole('button', { name: 'Reflect', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Reflect', exact: true });
  await sheet.getByLabel('What stayed with me?', { exact: true }).fill('A synthetic thought.');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('action')).toContainText('Book changed, refresh and retry.');
});

test('a refused read is reported honestly, never as books, and no streak or AI text appears', async ({ page }) => {
  const api = new MockApi();
  api.booksMode = 'refused';
  await api.install(page);
  await page.goto('/');
  const region = await openReading(page);
  await expect(region).toContainText('A book note could not be read.');
  await expect(region.getByTestId('reading-current')).toHaveCount(0);

  api.booksMode = 'ok';
  api.books = [book({ title: 'Reading One', reflections: [{ date: '2026-10-10', text: 'A synthetic reflection.' }] })];
  await page.reload();
  const refreshed = await openReading(page);
  await expect(refreshed).not.toContainText(/streak|target|goal|missed|challenge me/i);
  await expect(refreshed.getByTestId('reading-reflection')).toHaveCount(1);
});
