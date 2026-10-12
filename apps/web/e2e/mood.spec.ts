import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

const DAY_ONE = new Date('2026-09-24T10:00:00Z');
const NEXT_MORNING = new Date(DAY_ONE.getTime() + 86_400_000);
const CHECKED_IN = /^Checked in \d{2}:\d{2}$/;

const row = (page: Page) => page.getByRole('region', { name: 'Check-in', exact: true });
/** R3b: the inline row asks one question at a time; each group is named by what it asks. */
const target = (page: Page, kind: 'Mood' | 'Energy' | 'Sleep', name: string) =>
  row(page).getByRole('group', { name: kind, exact: true }).getByRole('button', { name, exact: true });

test('inline check-in end to end: mood -> energy -> sleep, saved once, the row is gone; Undo brings it back', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  // Review #7: the row sits between Next up and the tiles, with five round 48 px targets.
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toContainText('How are you today?');
  const next = await page.getByRole('region', { name: 'Next up', exact: true }).boundingBox();
  const box = await row(page).boundingBox();
  const tiles = await page.getByRole('group', { name: 'Today tiles' }).boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(next!.y + next!.height);
  expect(box!.y + box!.height).toBeLessThanOrEqual(tiles!.y);
  const moods = row(page).getByRole('group', { name: 'Mood', exact: true }).getByRole('button');
  await expect(moods).toHaveText(['−2', '−1', '0', '+1', '+2']);
  for (const b of await moods.all()) {
    const size = await b.boundingBox();
    expect([Math.round(size!.width), Math.round(size!.height)]).toEqual([48, 48]);
  }
  await expect(row(page)).toContainText('low');
  await expect(row(page)).toContainText('great');

  // One tap per question; nothing is enqueued before the last answer (MoodCheckin needs all three), no Skip.
  await target(page, 'Mood', 'Mood +2').click();
  await expect(row(page)).toContainText('Energy?');
  await expect(row(page).getByRole('button', { name: /skip/i })).toHaveCount(0);
  // The earlier answer is the way back.
  await row(page).getByRole('button', { name: 'Back: Mood +2' }).click();
  await expect(row(page)).toContainText('How are you today?');
  await target(page, 'Mood', 'Mood +2').click();
  await target(page, 'Energy', 'Energy −1').click();
  await expect(row(page)).toContainText('Sleep?');
  expect(api.applied).toEqual([]);
  await target(page, 'Sleep', 'Sleep 7 hours').click();

  // UX6: once today is checked in there is no row and no "Checked in HH:MM" anywhere on Today.
  await expect(row(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: CHECKED_IN })).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin']);
  const checkin = api.applied[0];
  expect(checkin?.type === 'MoodCheckin' && checkin.payload).toMatchObject({ mood: 2, energy: -1, sleep: 7 });
  // A round trip through another tab proves the saved check-in (not a stale step) hides it.
  await goTo(page, 'Notes');
  await goTo(page, 'Today');
  await expect(row(page)).toHaveCount(0);

  // The existing Undo path (Actions) brings the row back at its first question.
  const action = page.getByTestId('action').filter({ hasText: 'Mood check-in' });
  await action.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toContainText('How are you today?');
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin', 'UndoMoodCheckin']);
});

test('"Other" opens the full check-in sheet with the answers so far, for a half hour of sleep', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  await target(page, 'Mood', 'Mood −1').click();
  await target(page, 'Energy', 'Energy +1').click();
  await row(page).getByRole('button', { name: 'Other…', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Check-in' });
  const form = sheet.getByRole('region', { name: 'Mood check-in' });
  await expect(form.getByRole('button', { name: 'Mood −1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(form.getByRole('button', { name: 'Energy +1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await form.getByLabel('Sleep (hours)').fill('7,5'); // Danish comma
  await form.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row(page)).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin']);
  const checkin = api.applied[0];
  expect(checkin?.type === 'MoodCheckin' && checkin.payload).toMatchObject({ mood: -1, energy: 1, sleep: 7.5 });
});

test('today\'s check-in is edited from Log and Progress, and the row returns next morning', async ({ page }) => {
  await page.clock.install({ time: DAY_ONE });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  await target(page, 'Mood', 'Mood +2').click();
  await target(page, 'Energy', 'Energy −1').click();
  await target(page, 'Sleep', 'Sleep 8 hours').click();
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
  await expect(edit.getByLabel('Sleep (hours)')).toHaveValue('8');

  await edit.getByRole('button', { name: 'Mood −1', exact: true }).click();
  await edit.getByRole('button', { name: 'Check in', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['MoodCheckin', 'MoodCheckin']);
  const edited = api.applied[1];
  expect(edited?.type === 'MoodCheckin' && edited.payload).toMatchObject({ mood: -1, energy: -1, sleep: 8 });

  // Still no row on Today; the day's later check-in wins.
  await goTo(page, 'Today');
  await expect(row(page)).toHaveCount(0);

  // Next morning the date-keyed check-in no longer hides the row.
  await page.clock.setSystemTime(NEXT_MORNING);
  await page.clock.runFor(1000);
  await expect(row(page)).toBeVisible();
  await expect(row(page)).toContainText('How are you today?');
});
