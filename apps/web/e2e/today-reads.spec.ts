import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';

// Perf 2026-10-17 (docs/perf/2026-10-17-boards-performance.md): the Today view switch must not re-read, and the
// Overview must not read what only Boards shows.
const BOARDS_ONLY = ['/api/ai-usage', '/api/ai-budget', '/api/leaderboard', '/api/dashboard', '/api/power', '/api/sky',
  '/api/barometer', '/api/week-runway', '/api/monitors/vault-activity', '/api/monitors/job-radar'];

function recordApi(page: Page) {
  const calls: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) calls.push(pathname);
  });
  return calls;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await new MockApi().install(page);
});

test('the Overview reads nothing that only Boards shows', async ({ page }) => {
  const calls = recordApi(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await settle(page);
  expect(calls.filter((path) => BOARDS_ONLY.includes(path))).toEqual([]);
});

test('Boards reads scouts once, and going back to Overview reads nothing', async ({ page }) => {
  const calls = recordApi(page);
  await page.goto('/');
  await settle(page);
  calls.length = 0;
  await page.getByRole('button', { name: 'Boards', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Dashboard', exact: true })).toBeVisible();
  await settle(page);
  expect(calls.filter((path) => path === '/api/scouts')).toHaveLength(1);
  expect(calls).toContain('/api/ai-usage');
  calls.length = 0;
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await settle(page);
  expect(calls).toEqual([]);
});

test('a refresh while Boards shows makes the Overview re-read once when it is shown again', async ({ page }) => {
  const calls = recordApi(page);
  await page.goto('/');
  await settle(page);
  await page.getByRole('button', { name: 'Boards', exact: true }).click();
  await settle(page);
  calls.length = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await settle(page);
  expect(calls).toContain('/api/tasks');
  expect(calls).not.toContain('/api/morning');
  calls.length = 0;
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await settle(page);
  expect(calls.filter((path) => path === '/api/morning')).toHaveLength(1);
});
