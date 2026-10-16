// Redesign R3b (review #7, #9): Today's row order, tiles and 44 px switch; the Log's chip row, remembered view, single
// title and empty-state action. Synthetic mock data only.
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

const logChip = (page: import('@playwright/test').Page, name: string) =>
  page.getByRole('group', { name: 'Log view' }).getByRole('button', { name, exact: true });

test('Today runs Next up, check-in, tiles, then Since I was here; tiles name the noun once; the switch is a 44 px target', async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('seeded') === '1') return;
    window.sessionStorage.setItem('seeded', '1');
    window.localStorage.setItem('vc.sinceIWasHere', JSON.stringify({ at: 1, triage: [], scouts: { learning: 1 }, brief: '2026-09-29', papers: [] }));
  });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');

  const top = async (name: string, role: 'region' | 'group') => (await page.getByRole(role, { name, exact: true }).boundingBox())!.y;
  const order = [await top('Next up', 'region'), await top('Check-in', 'region'), await top('Today tiles', 'group'), await top('Since I was here', 'region')];
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  const tiles = page.getByRole('group', { name: 'Today tiles' });
  const needs = tiles.getByRole('button', { name: /^Needs you · \d+ items?$/ });
  await expect(needs.locator('.tile-label')).toHaveText('Needs you');
  await expect(needs.locator('.tile-body')).not.toContainText('Needs you');
  // Colour is the 2 px top edge, not uppercase text.
  await expect(needs).toHaveCSS('border-top-width', '2px');
  await expect(needs.locator('.tile-label')).toHaveCSS('text-transform', 'none');

  for (const name of ['Overview', 'Boards']) {
    const hit = await page.getByRole('group', { name: 'Today view' }).getByRole('button', { name, exact: true }).evaluate((b) => {
      const box = b.getBoundingClientRect();
      const after = getComputedStyle(b, '::after');
      return box.height - parseFloat(after.top) - parseFloat(after.bottom);
    });
    expect(hit, name).toBeGreaterThanOrEqual(44);
  }
});

test('the Log reopens on the view last shown, its chips scroll on one line, and no title repeats the chip', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await expect(logChip(page, 'Training')).toHaveAttribute('aria-pressed', 'true');

  // One line of chips that scrolls sideways (Reading starts past the edge on a 390 px phone).
  const tops = await page.getByRole('group', { name: 'Log view' }).getByRole('button').evaluateAll((chips) => chips.map((c) => Math.round(c.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);

  await logChip(page, 'Reading').click();
  await expect(page.getByRole('region', { name: 'Reading', exact: true })).toBeVisible();
  // One "Log" title; the selected chip is not repeated as a heading.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Log']);
  await expect(page.getByRole('heading', { name: 'Reading', exact: true })).toHaveCount(0);

  await goTo(page, 'Today');
  await goTo(page, 'Log');
  await expect(logChip(page, 'Reading')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Reading', exact: true })).toBeVisible();
  // The remembered chip is scrolled clear of the row's 16 px gutter and edge fade, not left under it.
  const row = await page.getByRole('group', { name: 'Log view' }).boundingBox();
  const chip = await logChip(page, 'Reading').boundingBox();
  expect(chip!.x + chip!.width).toBeLessThanOrEqual(row!.x + row!.width - 16 + 1);

  // A device preference survives a reload.
  await page.reload();
  await goTo(page, 'Log');
  await expect(logChip(page, 'Reading')).toHaveAttribute('aria-pressed', 'true');
});

test('an unknown remembered view falls back to Training', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('vc.logView', 'status'));
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await expect(logChip(page, 'Training')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Training sessions' })).toBeVisible();
});

test('an empty Training log offers its first session, opening the same sheet as the capture button', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  const training = page.getByRole('region', { name: 'Training sessions' });
  await expect(training).toContainText('No sessions yet.');
  await training.getByRole('button', { name: 'Log your first session', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Log training' })).toBeVisible();
});
