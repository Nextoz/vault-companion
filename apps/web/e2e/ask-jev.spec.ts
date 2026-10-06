import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('Ask Jev (JN1): asks from the open note, renders probability bars, and keeps the note path out of the URL', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');

  await goTo(page, 'Notes');
  await page.getByTestId('note-row').click();
  const note = page.getByRole('region', { name: 'Note', exact: true });
  await note.getByRole('button', { name: 'Ask Jev' }).click();

  const sheet = page.getByRole('dialog', { name: 'Ask Jev' });
  await sheet.getByRole('textbox', { name: 'Question 1' }).fill('Is this plan clear?');
  await sheet.getByRole('button', { name: 'Ask Jev' }).click();

  await expect(sheet.getByText('Is this plan clear?')).toBeVisible();
  await expect(sheet.getByText('70%')).toBeVisible();
  await expect(sheet.getByText('Based on this note only; a hint, not a verdict.')).toBeVisible();
  expect(api.askJevBodies).toHaveLength(1);
  const body = JSON.parse(api.askJevBodies[0]!) as { questions: { kind: string; question: string }[] };
  expect(body.questions).toEqual([{ kind: 'yes-no', question: 'Is this plan clear?' }]);
});
