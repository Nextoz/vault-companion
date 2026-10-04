import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

const DAY_ONE = new Date('2026-09-24T10:00:00Z');
const NEXT_MORNING = new Date(DAY_ONE.getTime() + 86_400_000);
const PROMPT = 'How are you today? Check in';
const CHECKED_IN = /^Checked in \d{2}:\d{2}$/;

test('mood check-in: chips, Danish sleep, no row on Today, and Undo brings the prompt back', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  // UX2: the form sits behind the one-line check-in prompt until it is tapped.
  const prompt = page.getByRole('button', { name: PROMPT });
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
  await card.getByRole('button', { name: 'Energy \u22121', exact: true }).click();
  await card.getByLabel('Sleep (hours)').fill('7,5'); // Danish comma
  await expect(save).toBeEnabled();
  await save.click();

  // UX6: once today is checked in there is no row, no form and no "Checked in HH:MM" anywhere on Today.
  await expect(page.getByRole('region', { name: 'Mood check-in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: CHECKED_IN })).toHaveCount(0);
  await expect(prompt).toHaveCount(0);
  // A round trip through another tab proves the check-in (not a stale open flag) hides it.
  await goTo(page, 'Notes');
  await goTo(page, 'Today');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Mood check-in' })).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin']);
  const checkin = api.applied[0];
  expect(checkin?.type === 'MoodCheckin' && checkin.payload).toMatchObject({ mood: 2, energy: -1, sleep: 7.5 });

  const action = page.getByTestId('action').filter({ hasText: 'Mood check-in' });
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  // Undoing the check-in brings the prompt back; tap it to reach the form again.
  await expect(prompt).toBeVisible();
  await prompt.click();
  await expect(card.getByLabel('Sleep (hours)')).toBeVisible();
  await expect(card.getByRole('button', { name: CHECKED_IN })).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin', 'UndoMoodCheckin']);
});

test('today\'s check-in is edited from Log and Progress, and the row returns next morning', async ({ page }) => {
  await page.clock.install({ time: DAY_ONE });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  const prompt = page.getByRole('button', { name: PROMPT });
  await prompt.click();
  const card = page.getByRole('region', { name: 'Mood check-in' });
  await card.getByRole('button', { name: 'Mood +2', exact: true }).click();
  await card.getByRole('button', { name: 'Energy \u22121', exact: true }).click();
  await card.getByLabel('Sleep (hours)').fill('7,5');
  await card.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin']);

  // UX5/UX6: today's entry now carries the Edit control in the Log's Progress view.
  await goTo(page, 'Log');
  await goTo(page, 'Progress');
  const mood = page.getByRole('region', { name: 'Mood', exact: true });
  await mood.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('region', { name: 'Mood check-in' });
  await expect(edit).toBeVisible();
  // Prefilled from the saved check-in.
  await expect(edit.getByRole('button', { name: 'Mood +2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(edit.getByLabel('Sleep (hours)')).toHaveValue('7.5');

  await edit.getByRole('button', { name: 'Mood \u22121', exact: true }).click();
  await edit.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin', 'MoodCheckin']);
  const edited = api.applied[1];
  expect(edited?.type === 'MoodCheckin' && edited.payload).toMatchObject({ mood: -1, energy: -1, sleep: 7.5 });

  // Still no row on Today; the day's later check-in wins.
  await goTo(page, 'Today');
  await expect(page.getByRole('button', { name: PROMPT })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Mood check-in' })).toHaveCount(0);

  // Next morning the date-keyed check-in no longer hides the prompt.
  await page.clock.setSystemTime(NEXT_MORNING);
  await goTo(page, 'Notes');
  await goTo(page, 'Today');
  await expect(page.getByRole('button', { name: PROMPT })).toBeVisible();
  await page.getByRole('button', { name: PROMPT }).click();
  await expect(page.getByRole('region', { name: 'Mood check-in' })).toBeVisible();
});
