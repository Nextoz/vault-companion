// ADR-0064: completing a task re-reads the Character and plays the celebrations in order. Synthetic mock data only.
import { expect, test, type Page } from '@playwright/test';
import { GameResponse } from '@vault-companion/contracts';
import { ACCOUNT, MockApi, sampleGame, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';
import { seenKey } from '../src/achievements.ts';

/** The read after the completion: +6 XP with one critical, a skill up, one new achievement and a level up. */
function after(): GameResponse {
  const base = sampleGame();
  return GameResponse.parse({
    ...base,
    revision: 'b'.repeat(40),
    character: {
      ...base.character,
      xp: base.character.xp + 6, level: base.character.level + 1, levelXp: 4, levelCost: 280,
      professions: base.character.professions.map((p) => p.id === 'quartermaster' ? { ...p, skill: p.skill + 1, xp: p.xp + 6 } : p),
      achievements: base.character.achievements.map((a) => a.id === 'a4' ? { ...a, earned: true, earnedDate: '2026-09-30', progress: { current: 25, target: 25 } } : a),
    },
    feedback: { ...base.feedback!, criticals: 1, achievements: { a4: { description: 'Log 25 training sessions.', earnedBy: 'Completing a task' } } },
  });
}

/** Default fixture's earned achievements are already seen, so no on-open banner competes with the reward. */
async function openWithReward(page: Page): Promise<MockApi> {
  const api = new MockApi();
  api.gameAfterCommand = after();
  api.open = [taskView(10, 'Water the plants')];
  // The task fixture is due on this day (as in app.spec.ts); the clock still runs.
  await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });
  await page.addInitScript((key) => { window.localStorage.setItem(key, JSON.stringify(['a1', 'a2', 'a3'])); }, seenKey(ACCOUNT));
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  return api;
}

test('a completed task plays Critical XP, the skill up, the achievement banner and the level up, in that order', async ({ page }) => {
  await openWithReward(page);
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();

  await expect(page.locator('.reward-xp.is-critical')).toHaveText('Critical! +6 XP');
  await expect(page.locator('.reward-skill')).toHaveText('Your skill in Quartermaster has increased to 121.');

  const banner = page.locator('.reward-banner');
  await expect(banner).toContainText('Twenty-five Sessions');
  await expect(banner).toContainText('Log 25 training sessions.');
  await expect(banner).toContainText('Earned by completing a task');
  await banner.getByRole('button', { name: 'Dismiss' }).click();

  const level = page.getByRole('button', { name: /Level 13 reached/ });
  await expect(level).toBeVisible();
  await expect(level).toContainText('Next level in 276 XP');
  await level.click();
  await expect(level).toHaveCount(0);

  // Marked seen on this device: a reload does not announce the same achievement again.
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('.reward-banner')).toHaveCount(0);
});

test('a banner tap opens the Character', async ({ page }) => {
  await openWithReward(page);
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await page.getByRole('button', { name: /Achievement earned: Twenty-five Sessions/ }).click();
  await expect(page.getByRole('dialog', { name: 'Character' })).toBeVisible();
});

test('the Character sheet switches reward sounds off and remembers it', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('button', { name: 'Open Character' }).click();
  const toggle = page.getByRole('switch', { name: /Reward sounds/ });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(await page.evaluate(() => window.localStorage.getItem('vc.sound'))).toBe('0');
});
