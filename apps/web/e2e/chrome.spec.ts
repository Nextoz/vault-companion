// Redesign R3a (review #8, C3, D2): the large-title header, the capture button that names what it adds, and the
// global XP strip on the tab bar. Synthetic mock data only.
import { expect, test, type Page } from '@playwright/test';
import { GameResponse } from '@vault-companion/contracts';
import { ACCOUNT, MockApi, sampleGame, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';
import { seenKey } from '../src/achievements.ts';

const logView = (page: Page, view: string) =>
  page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: view, exact: true }).click();

/** The strip's fill and rested run as fractions of its width. */
const stripShare = (page: Page) => page.getByTestId('xp-strip').evaluate((strip) => {
  const width = strip.getBoundingClientRect().width;
  const part = (selector: string) => (strip.querySelector(selector)?.getBoundingClientRect().width ?? 0) / width;
  return { fill: part('.xp-strip-fill'), rested: part('.xp-strip-rested') };
});

test('the capture button names what it adds on every screen', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const fab = page.locator('.fab');
  for (const screen of ['Today', 'Tasks', 'Scouts', 'Notes', 'Progress'] as const) {
    await goTo(page, screen);
    await expect(fab, screen).toHaveText('Capture');
    await expect(fab, screen).toHaveAccessibleName('Capture');
  }
  await goTo(page, 'Log');
  await expect(fab).toHaveText('Training');
  await expect(fab).toHaveAccessibleName('Add training');
  for (const [view, verb, name] of [['Learning', 'Session', 'Add session'], ['Reading', 'Reading', 'Log reading'], ['Health', 'Capture', 'Capture']]) {
    await logView(page, view!);
    await expect(fab, view).toHaveText(verb!);
    await expect(fab, view).toHaveAccessibleName(name!);
  }
});

test('the capture pill shrinks to a 48 px circle while scrolling down and extends on the way up', async ({ page }) => {
  const api = new MockApi();
  api.open = Array.from({ length: 30 }, (_, i) => taskView(10 + i, `Synthetic task ${i + 1}`));
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'All');
  const fab = page.locator('.fab');
  await expect(fab).not.toHaveAttribute('data-compact');
  expect((await fab.boundingBox())!.width).toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(fab).toHaveAttribute('data-compact');
  await expect.poll(async () => Math.round((await fab.boundingBox())!.width)).toBe(48);
  await expect(fab).toHaveAccessibleName('Capture');
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(fab).not.toHaveAttribute('data-compact');
});

test('Capture offers Training and Check-in, which open their own sheets', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const capture = page.getByRole('dialog', { name: 'Capture', exact: true });
  const types = capture.getByRole('group', { name: 'Log instead' });

  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(capture.getByRole('group', { name: 'Capture type' }).getByRole('button')).toHaveText(['Task', 'Note', 'Active Work']);
  await expect(types.getByRole('button')).toHaveText(['Training', 'Check-in']);
  await types.getByRole('button', { name: 'Training', exact: true }).click();
  await expect(capture).toHaveCount(0);
  const training = page.getByRole('dialog', { name: 'Log training' });
  await expect(training).toBeVisible();
  await expect(training.getByRole('group', { name: 'Training type' })).toBeVisible();
  await training.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(training).toHaveCount(0);

  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await types.getByRole('button', { name: 'Check-in', exact: true }).click();
  const checkin = page.getByRole('dialog', { name: 'Check-in' });
  await expect(checkin.getByRole('region', { name: 'Mood check-in' })).toBeVisible();
});

test('the XP strip matches the Character read, names the level on the Log tab, and a hold on Log opens Character', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const strip = page.getByTestId('xp-strip');
  await expect(strip).toHaveAttribute('aria-hidden', 'true');
  // Fixture: level 12, 156 / 265 XP into the level, 90 rested.
  await expect.poll(async () => (await stripShare(page)).fill).toBeCloseTo(156 / 265, 2);
  expect((await stripShare(page)).rested).toBeCloseTo(90 / 265, 2);
  await expect(strip.locator('.xp-strip-zz')).toHaveText('zz');
  expect((await strip.boundingBox())!.height).toBe(3);
  const log = page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Log, level 12', exact: true });
  await expect(log).toBeVisible();

  // Strip and the tab labels never overlap: the strip sits on the bar's top edge, above every label.
  const labels = await page.locator('.tabbar .tab span').first().boundingBox();
  const stripBox = await strip.boundingBox();
  expect(stripBox!.y + stripBox!.height).toBeLessThan(labels!.y);

  // A 500 ms hold on Log opens the Character sheet and does not switch tabs.
  const box = (await log.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
  await expect(page.getByRole('dialog', { name: 'Character' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Log view' })).toHaveCount(0);
});

test('an XP gain lands on the strip: the fill moves to the new value and glows', async ({ page }) => {
  const api = new MockApi();
  const base = sampleGame();
  api.gameAfterCommand = GameResponse.parse({
    ...base, revision: 'b'.repeat(40),
    character: { ...base.character, xp: base.character.xp + 20, levelXp: base.character.levelXp + 20 },
  });
  api.open = [taskView(10, 'Water the plants')];
  await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });
  await page.addInitScript((key) => { window.localStorage.setItem(key, JSON.stringify(['a1', 'a2', 'a3'])); }, seenKey(ACCOUNT));
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  await expect.poll(async () => (await stripShare(page)).fill).toBeCloseTo(156 / 265, 2);
  await page.getByRole('button', { name: 'Complete: Water the plants' }).click();
  await expect(page.locator('.reward-xp')).toHaveText('+20 XP');
  await expect(page.locator('.xp-strip-glow')).toHaveCount(1);
  await expect.poll(async () => (await stripShare(page)).fill).toBeCloseTo(176 / 265, 2);
});

test('one large-title header: real h1 titles that move into the bar, and a stale read as a chip that opens Status', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-26T12:10:00Z') });
  const api = new MockApi();
  api.open = Array.from({ length: 30 }, (_, i) => taskView(10 + i, `Synthetic task ${i + 1}`));
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks', exact: true })).toBeVisible();
  await goTo(page, 'All');
  await expect(page.getByRole('heading', { level: 1, name: 'All tasks', exact: true })).toBeVisible();
  // No Vault status paragraph or Refresh button on the screens any more.
  await expect(page.getByRole('region', { name: 'Vault status' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh vault' })).toHaveCount(0);

  const bar = page.locator('header.top');
  await expect(bar).not.toHaveAttribute('data-collapsed');
  await expect(bar.locator('.top-title')).toHaveCSS('opacity', '0');
  await page.evaluate(() => window.scrollTo(0, 300));
  await expect(bar).toHaveAttribute('data-collapsed');
  await expect(bar.locator('.top-title')).toHaveText('All tasks');
  await expect(bar.locator('.top-title')).toHaveCSS('opacity', '1');
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).not.toHaveAttribute('data-collapsed');

  // Ten minutes without a read: a yellow chip in the bar; it opens the Status screen, which can refresh.
  await expect(page.getByRole('button', { name: /^Vault stale/ })).toHaveCount(0);
  await page.clock.fastForward(10 * 60 * 1000 + 1000);
  const chip = page.getByRole('button', { name: 'Vault stale: open Status' });
  await expect(chip).toHaveText('Stale');
  await chip.click();
  await expect(page.getByRole('region', { name: 'Vault status' }).getByRole('button', { name: 'Refresh vault' })).toBeVisible();
});

test('the selected tab is marked aria-current="page", not aria-pressed (R5)', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Views' });
  await expect(nav.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: 'Tasks', exact: true })).not.toHaveAttribute('aria-current');
  await expect(nav.locator('[aria-pressed]')).toHaveCount(0);
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(nav.getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('button', { name: 'Today', exact: true })).not.toHaveAttribute('aria-current');
});
