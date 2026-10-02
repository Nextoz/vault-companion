import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

const PATH = 'Inbox/Seed order - 2026-09-23.md';

test('Notes (ADR-0022): list → view → edit offline → saved; frontmatter never shown or sent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const list = page.getByRole('region', { name: 'Notes', exact: true });
  await expect(list.getByTestId('note-row')).toHaveCount(1);
  await expect(list.getByTestId('note-row')).toContainText('Seed order');
  await expect(list.getByTestId('note-row')).toContainText('2026-09-23');
  await list.getByTestId('note-row').click();

  const note = page.getByRole('region', { name: 'Note', exact: true });
  await expect(note.getByRole('heading', { name: 'Seed order' })).toBeVisible();
  // Sanitised Markdown render of the body only; the frontmatter stays out of view.
  await expect(note.getByTestId('note-body').locator('strong')).toHaveText('basil');
  await expect(note.getByTestId('note-body')).not.toContainText('inbox-note');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await note.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit note' });
  const box = sheet.getByRole('textbox', { name: 'Note text' });
  await expect(box).toHaveValue('Tomatoes and **basil**.\n');
  await box.fill('Tomatoes, basil and chives.\nOrder by Friday.');

  // Offline: the edit waits on the device and is sent once the network is back.
  api.network = 'down';
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(note.getByTestId('note-edit-state')).toHaveText('Saving your edit…');
  expect(api.noteEdits).toHaveLength(0);

  api.network = 'up';
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => api.noteEdits.length).toBe(1);
  expect(api.noteEdits[0]).toEqual({ path: PATH, blobSha: 'd'.repeat(40), body: 'Tomatoes, basil and chives.\nOrder by Friday.' });
  await expect(note.getByTestId('note-edit-state')).toHaveText('Saved to the vault; reaches Obsidian at your next desktop sync');
  await expect(note.getByTestId('note-body')).toContainText('Order by Friday.');
});

test('SP3 (ADR-0038): a note seen before reopens from its labelled copy when the read fails; a copy is never editable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByTestId('note-row').click();
  const note = page.getByRole('region', { name: 'Note', exact: true });
  await expect(note.getByTestId('note-body').locator('strong')).toHaveText('basil');
  await expect(note.getByTestId('copy-note')).toHaveCount(0);
  await expect(note.getByRole('button', { name: 'Edit' })).toBeEnabled();

  await page.getByRole('button', { name: 'Training', exact: true }).click();
  api.network = 'down';
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const list = page.getByRole('region', { name: 'Notes', exact: true });
  await expect(list.getByTestId('copy-note')).toHaveText(/^Could not refresh · showing the copy from \d\d:\d\d$/);
  await list.getByTestId('note-row').click();
  await expect(note.getByTestId('note-body').locator('strong')).toHaveText('basil');
  await expect(note.getByTestId('copy-note')).toHaveText(/^Could not refresh · showing the copy from \d\d:\d\d$/);
  await expect(note.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('sp3-note-copy-390x844.png') });
});
