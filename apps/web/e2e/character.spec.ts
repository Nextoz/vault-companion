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
  // R3b: the card is one 56 px strip (level badge, XP bar, points, chevron); no "Tap for Character" line.
  await expect(card).toHaveAccessibleName(/level 12, 156 \/ 265 XP, \d+ points$/);
  await expect(card).toContainText('156 / 265 XP');
  await expect(card).not.toContainText('Tap for Character');
  expect(Math.round((await card.boundingBox())!.height)).toBe(56);
  await card.click();

  const dialog = page.getByRole('dialog', { name: 'Character' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('character-profession')).toHaveCount(4);
  // Plan screen 2: each ring names its rank and skill against the live cap; in-progress achievements are tracked.
  await expect(dialog.getByRole('button', { name: 'Athletics: Expert, skill 145 of 300, 1200 XP' })).toBeVisible();
  await expect(dialog.getByTestId('character-tracked')).toHaveCount(2);
  await expect(dialog.getByTestId('character-tracked').first()).toContainText('18 / 25');
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
  await expect(dialog).toContainText('Athletics (training session): 30 XP per entry, up to 2 a day');
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
  await expect(page.getByRole('button', { name: 'Open Character' })).toHaveAccessibleName(/level 12/);
});

test('the sheet header covers nothing at rest and stays flush with the top when scrolled', async ({ page }) => {
  // 2026-10-11: the sticky header sat 22px low in WebKit, hiding the first line and letting text show above it.
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('button', { name: 'Open Character' }).click();
  const dialog = page.getByRole('dialog', { name: 'Character' });
  await expect(dialog.locator('.character-hero')).toBeVisible();
  const edges = () => dialog.evaluate((sheet) => {
    const header = sheet.querySelector('.sheet-header')!.getBoundingClientRect();
    const hero = sheet.querySelector('.character-hero')!.getBoundingClientRect();
    return { sheetTop: sheet.getBoundingClientRect().top, headerTop: header.top, headerBottom: header.bottom, heroTop: hero.top };
  });
  const header = dialog.locator('.sheet-header');
  const rest = await edges();
  expect(rest.headerTop).toBeCloseTo(rest.sheetTop, 0);
  expect(rest.heroTop).toBeGreaterThanOrEqual(rest.headerBottom);
  await expect(header).not.toHaveAttribute('data-scrolled');
  await dialog.evaluate((sheet) => { sheet.scrollTop = 90; });
  // The hairline marks the edge only while content is under the header.
  await expect(header).toHaveAttribute('data-scrolled');
  const scrolled = await edges();
  expect(scrolled.headerTop).toBeCloseTo(scrolled.sheetTop, 0);
  await dialog.evaluate((sheet) => { sheet.scrollTop = 0; });
  await expect(header).not.toHaveAttribute('data-scrolled');
});
