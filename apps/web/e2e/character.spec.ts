// GAM1-B: the Log Character card, the Character screen, the profession ring destinations and "How XP works".
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('card -> Character screen -> ring -> its Log view -> Back returns to Character', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');

  const card = page.getByRole('button', { name: 'Open Character' });
  await expect(card).toContainText('Level 12');
  await expect(card).toContainText('156 / 265 XP');
  await card.click();

  const dialog = page.getByRole('dialog', { name: 'Character' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('character-profession')).toHaveCount(4);
  await expect(dialog).toContainText('Expert · 145/300');
  await expect(dialog.getByTestId('character-achievement')).toHaveCount(3);
  // No XP is implied for health and there is no streak counter; the step milestones of GAM1-C are not on this screen.
  await expect(dialog).not.toContainText(/streak/i);

  await dialog.getByRole('button', { name: 'Athletics' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Training', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page.getByRole('dialog', { name: 'Character' })).toBeVisible();
});

test('How XP works prints the live rules from the payload, and Back returns to the Character screen', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('button', { name: 'Open Character' }).click();

  const dialog = page.getByRole('dialog', { name: 'Character' });
  await dialog.getByRole('button', { name: 'How XP works' }).click();
  await expect(dialog).toContainText('Where XP comes from');
  await expect(dialog).toContainText('Athletics: 30 XP per entry, up to 2 a day');
  await expect(dialog).toContainText('Level curve');
  await expect(dialog).toContainText('Rested XP');

  await dialog.getByRole('button', { name: /Back/ }).click();
  await expect(dialog.getByRole('button', { name: 'How XP works' })).toBeVisible();
});

test('a named unavailable source is shown as a word, never a zero', async ({ page }) => {
  const api = new MockApi();
  api.gameUnavailable = ['training'];
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('button', { name: 'Open Character' }).click();
  const dialog = page.getByRole('dialog', { name: 'Character' });
  await expect(dialog).toContainText('Training unavailable');
});

test('a failed Character read is honest and Retry re-reads', async ({ page }) => {
  const api = new MockApi();
  api.gameMode = 'error';
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await expect(page.getByText('Character could not be loaded.')).toBeVisible();
  api.gameMode = 'ok';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Character' })).toContainText('Level 12');
});
