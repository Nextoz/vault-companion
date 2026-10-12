// GAM1-C: the Achievements page (plan screens 3-4) and, since ADR-0064, the on-open banners. Synthetic mock data only.
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNT, MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';
import { seenKey } from '../src/achievements.ts';

/** Open the Character screen from the Log card, then its Achievements page. */
async function openAchievements(page: Page, api: MockApi) {
  api.gameAchievements = true;
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('button', { name: 'Open Character' }).click();
  const dialog = page.getByRole('dialog', { name: 'Character' });
  await dialog.getByRole('button', { name: 'All achievements' }).click();
  return dialog;
}

test('All achievements groups by category with counters, masks hidden ones, marks meta and lists feats and Walking', async ({ page }) => {
  const api = new MockApi();
  const dialog = await openAchievements(page, api);

  // Screen 2 -> 3: the header keeps a "‹ Character" Back and shows the earned total (feats excluded).
  await expect(dialog.getByRole('button', { name: 'Back to Character' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '55 pts' })).toBeVisible();

  // One section per category, headed CATEGORY · earned / total.
  await expect(dialog.getByRole('heading', { name: 'General · 2 / 3' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Training · 1 / 3' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Learning · 1 / 4' })).toBeVisible();

  // Every achievement is a tile button in the grid (10 achievements + 1 feat).
  await expect(dialog.getByTestId('achievement-tile')).toHaveCount(11);

  // An unearned hidden achievement shows a single ? in its frame, with no points and no progress (R4).
  const hidden = dialog.locator('.achievement-tile.is-hidden');
  await expect(hidden).toHaveCount(3);
  await expect(hidden.first()).toHaveText('?');
  await expect(hidden.first()).not.toContainText('pts');

  // A chain shows its tier, a counter its percent, a meta tile is marked.
  await expect(dialog.locator('.achievement-tile', { hasText: 'Scholar run II' })).toContainText('2/4');
  await expect(dialog.locator('.achievement-tile', { hasText: 'Twenty-five Sessions' })).toContainText('80%');
  await expect(dialog.locator('.achievement-tile', { hasText: 'Renaissance' })).toContainText('Meta');

  // Feats of Strength: listed, always 0 pts, never in the total.
  await expect(dialog.getByRole('heading', { name: 'Feats of Strength · 0 pts' })).toBeVisible();
  await expect(dialog.locator('.achievement-tile', { hasText: 'Founding Reader' })).toContainText('0 pts');

  // steps.jpg: NEXT bars across, EARNED newest first, and the points-only footer.
  await expect(dialog.getByText('12.0M / 12.5M')).toBeVisible();
  const earned = dialog.getByTestId('achievement-walking').locator('li');
  await expect(earned).toHaveCount(4);
  await expect(earned.first()).toContainText('10 million steps');
  await expect(earned.first()).toContainText('25 pts');
  await expect(dialog.getByText('Points only, no XP · no daily goal, no streak')).toBeVisible();
});

test('a tile opens the badge detail; Pin toggles, a fourth pin is refused, and Tracked keeps pin order', async ({ page }) => {
  const api = new MockApi();
  const dialog = await openAchievements(page, api);
  const pin = async (name: string) => {
    await dialog.locator('.achievement-tile', { hasText: name }).click();
    const sheet = page.getByRole('dialog', { name });
    await sheet.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(sheet.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
  };

  // Screen 4: chain, points and the progress bar.
  await dialog.locator('.achievement-tile', { hasText: 'Scholar run II' }).click();
  const detail = page.getByRole('dialog', { name: 'Scholar run II' });
  await expect(detail).toContainText('chain 2 of 4');
  await expect(detail).toContainText('10 pts');
  await expect(detail).toContainText('4 / 7');
  // The locked reason shows only in the detail.
  await detail.getByRole('button', { name: 'Close' }).click();
  await dialog.locator('.achievement-tile', { hasText: 'Iron Will' }).click();
  const locked = page.getByRole('dialog', { name: 'Iron Will' });
  await expect(locked).toContainText('Reach level 20 first.');
  await locked.getByRole('button', { name: 'Close' }).click();

  await pin('Scholar run II');
  await pin('Twenty-five Sessions');
  await pin('Iron Will');
  // A fourth pin is refused, with a short visible note, and nothing is added.
  await dialog.locator('.achievement-tile', { hasText: 'Renaissance' }).click();
  const refused = page.getByRole('dialog', { name: 'Renaissance' });
  await refused.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(refused).toContainText('You can pin up to 3 achievements.');
  await refused.getByRole('button', { name: 'Close' }).click();

  // Escape leaves the page for the overview, where Tracked lists the pins in pin order.
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'All achievements' })).toBeVisible();
  const tracked = dialog.getByTestId('character-tracked');
  await expect(tracked).toHaveCount(3);
  await expect(tracked.nth(0)).toContainText('Scholar run II');
  await expect(tracked.nth(1)).toContainText('Twenty-five Sessions');
  await expect(tracked.nth(2)).toContainText('Iron Will');
});

test('Close and Escape on the detail return focus to the tile that opened it', async ({ page }) => {
  const api = new MockApi();
  const dialog = await openAchievements(page, api);
  const tile = dialog.locator('.achievement-tile', { hasText: 'Ten Sessions' });
  await tile.click();
  await expect(page.getByRole('dialog', { name: 'Ten Sessions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Ten Sessions' })).toHaveCount(0);
  await expect(tile).toBeFocused();
});

test('the first open shows one summary toast, and a reload shows nothing', async ({ page }) => {
  const api = new MockApi();
  api.gameAchievements = true;
  await api.install(page);
  await page.goto('/');
  const summary = page.getByRole('status').filter({ hasText: '4 step milestones earned since 2024' });
  await expect(summary).toContainText('4 step milestones earned since 2024');
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'step milestones earned' })).toHaveCount(0);
});

test('with a seen record, the newest unseen achievements arrive as banners, one at a time', async ({ page }) => {
  const api = new MockApi();
  api.gameAchievements = true;
  await page.addInitScript((key) => { window.localStorage.setItem(key, JSON.stringify(['r1'])); }, seenKey(ACCOUNT));
  await api.install(page);
  await page.goto('/');
  const banner = page.locator('.reward-banner');
  const names: string[] = [];
  for (let i = 0; i < 3; i++) {
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText('Achievement earned');
    names.push((await banner.locator('.reward-banner-name').textContent()) ?? '');
    await banner.getByRole('button', { name: 'Dismiss' }).click();
  }
  expect(names.sort()).toEqual(['Renaissance', 'Scholar run I', 'Ten Sessions']);
  await expect(banner).toHaveCount(0);
});

test('the badge detail says what the achievement asks and what earned it', async ({ page }) => {
  const api = new MockApi();
  const dialog = await openAchievements(page, api);
  await dialog.locator('.achievement-tile', { hasText: 'Ten Sessions' }).click();
  const detail = page.getByRole('dialog', { name: 'Ten Sessions' });
  await expect(detail.getByText('Log 10 training sessions.')).toBeVisible();
  await expect(detail.getByTestId('achievement-earned-line')).toContainText('Earned by logging a training session');
});
