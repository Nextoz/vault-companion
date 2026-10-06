import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('Ask Jev (JN1): asks one yes/no, one choose and one rate question in a single request and renders each answer bars', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');

  await goTo(page, 'Notes');
  await page.getByTestId('note-row').click();
  const note = page.getByRole('region', { name: 'Note', exact: true });
  await note.getByRole('button', { name: 'Ask Jev' }).click();

  const sheet = page.getByRole('dialog', { name: 'Ask Jev' });
  await sheet.getByRole('textbox', { name: 'Question 1', exact: true }).fill('Is this plan clear?');
  await sheet.getByRole('button', { name: 'Add question' }).click();
  await sheet.getByRole('combobox', { name: 'Question 2 type' }).selectOption('choose');
  await sheet.getByRole('textbox', { name: 'Question 2', exact: true }).fill('Which order should I use?');
  await sheet.getByRole('textbox', { name: 'Question 2 options' }).fill('A, B');
  await sheet.getByRole('button', { name: 'Add question' }).click();
  await sheet.getByRole('combobox', { name: 'Question 3 type' }).selectOption('rate');
  await sheet.getByRole('textbox', { name: 'Question 3', exact: true }).fill('How ready is this?');
  await sheet.getByRole('textbox', { name: 'Question 3 scale labels' }).fill('Low, High');
  await sheet.getByRole('button', { name: 'Ask Jev' }).click();

  const yesNo = sheet.getByRole('region', { name: 'Answer 1' });
  await expect(yesNo.getByRole('heading', { name: 'Is this plan clear?' })).toBeVisible();
  await expect(yesNo.getByText('Yes')).toBeVisible();
  await expect(yesNo.getByText('70%')).toBeVisible();
  await expect(yesNo.getByText('No')).toBeVisible();
  await expect(yesNo.getByText('30%')).toBeVisible();

  const choose = sheet.getByRole('region', { name: 'Answer 2' });
  await expect(choose.getByRole('heading', { name: 'Which order should I use?' })).toBeVisible();
  await expect(choose.getByText('A')).toBeVisible();
  await expect(choose.getByText('60%')).toBeVisible();
  await expect(choose.getByText('B')).toBeVisible();
  await expect(choose.getByText('40%')).toBeVisible();

  const rate = sheet.getByRole('region', { name: 'Answer 3' });
  await expect(rate.getByRole('heading', { name: 'How ready is this?' })).toBeVisible();
  await expect(rate.getByText('Low')).toBeVisible();
  await expect(rate.getByText('20%')).toBeVisible();
  await expect(rate.getByText('High')).toBeVisible();
  await expect(rate.getByText('80%')).toBeVisible();
  await expect(sheet.getByText('Based on this note only; a hint, not a verdict.')).toBeVisible();
  expect(api.askJevBodies).toHaveLength(1);
  const body = JSON.parse(api.askJevBodies[0]!) as { questions: { kind: string; question: string; options?: string[]; levels?: string[] }[] };
  expect(body.questions).toEqual([
    { kind: 'yes-no', question: 'Is this plan clear?' },
    { kind: 'choose', question: 'Which order should I use?', options: ['A', 'B'] },
    { kind: 'rate', question: 'How ready is this?', levels: ['Low', 'High'] },
  ]);
});

test('Ask Jev (JN1): returns focus to the Ask Jev button however the sheet closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');

  await goTo(page, 'Notes');
  await page.getByTestId('note-row').click();
  const note = page.getByRole('region', { name: 'Note', exact: true });
  const askButton = note.getByRole('button', { name: 'Ask Jev' });

  await askButton.click();
  let sheet = page.getByRole('dialog', { name: 'Ask Jev' });
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(askButton).toBeFocused();

  await askButton.click();
  sheet = page.getByRole('dialog', { name: 'Ask Jev' });
  await sheet.getByRole('textbox', { name: 'Question 1', exact: true }).fill('Is this plan clear?');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(askButton).toBeFocused();

  await askButton.click();
  sheet = page.getByRole('dialog', { name: 'Ask Jev' });
  await sheet.getByRole('textbox', { name: 'Question 1', exact: true }).fill('Is this plan clear?');
  await sheet.getByRole('button', { name: 'Ask Jev' }).click();
  await expect(sheet.getByRole('region', { name: 'Answer 1' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(askButton).toBeFocused();
});
