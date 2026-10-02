import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('mood check-in: chips, Danish sleep, collapse to "Checked in", and Undo', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  // UX2: the form sits behind the one-line check-in prompt until it is tapped.
  const prompt = page.getByRole('button', { name: 'How are you today? Check in' });
  await prompt.click();
  const card = page.getByRole('region', { name: 'Mood check-in' });
  await expect(card).toBeVisible();
  // B8: each chip row carries a visible label and what its scale ends mean.
  for (const [label, low, high] of [['Mood', 'low', 'great'], ['Energy', 'drained', 'energised']] as const) {
    const row = card.locator('.scale-row').filter({ has: page.getByRole('group', { name: label, exact: true }) });
    await expect(row.locator('.scale-label')).toHaveText(label);
    await expect(row.locator('.scale-ends')).toContainText(low);
    await expect(row.locator('.scale-ends')).toContainText(high);
  }
  const save = card.getByRole('button', { name: 'Check in', exact: true });
  await expect(save).toBeDisabled();

  await card.getByRole('button', { name: 'Mood +2', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Mood +2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(save).toBeDisabled();

  await card.getByRole('button', { name: 'Energy \u22121', exact: true }).click();
  await expect(save).toBeDisabled();

  await card.getByLabel('Sleep (hours)').fill('7,5'); // Danish comma
  await expect(save).toBeEnabled();
  await save.click();

  await expect(card.getByRole('button', { name: /^Checked in \d{2}:\d{2}$/ })).toBeVisible();
  await expect(card.getByLabel('Sleep (hours)')).toHaveCount(0);
  // A check-in for today hides the prompt (UX2).
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin']);
  const checkin = api.applied[0];
  expect(checkin?.type === 'MoodCheckin' && checkin.payload).toMatchObject({ mood: 2, energy: -1, sleep: 7.5 });

  const action = page.getByTestId('action').filter({ hasText: 'Mood check-in' });
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(card.getByLabel('Sleep (hours)')).toBeVisible();
  await expect(card.getByRole('button', { name: /^Checked in \d{2}:\d{2}$/ })).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin', 'UndoMoodCheckin']);
});
