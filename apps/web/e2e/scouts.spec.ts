import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('Today attention opens Scouts, panels and history lead to sanitised findings at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: '1 scouts need attention' }).click();
  const scouts = page.getByRole('region', { name: 'Scouts', exact: true });
  const failed = scouts.getByRole('button', { name: /City events/ });
  const healthy = scouts.getByRole('button', { name: /Learning opportunities/ });
  await expect(failed).toContainText('Failed');
  await expect(failed).toContainText('Last attempt Today 06:50');
  await expect(failed).toContainText('— findings');
  await expect(healthy).toContainText('Healthy');
  await expect(healthy).toContainText('4 findings');
  await expect(healthy).toContainText('Sources 3/3');
  await expect(scouts.getByRole('button', { name: /unreadable.json/ })).toContainText('No status yet');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await failed.click();
  await expect(scouts.getByRole('list', { name: 'Run history, oldest to newest' }).getByRole('listitem')).toHaveCount(1);
  await expect(scouts).toContainText('runner could not start');
  await scouts.getByRole('button', { name: 'Back to scouts' }).click();
  await healthy.click();
  const runs = scouts.getByRole('list', { name: 'Run history, oldest to newest' }).getByRole('listitem');
  await expect(runs).toHaveCount(2);
  await expect(runs.first()).toHaveAttribute('aria-label', /26 Sep 2026.*degraded/);
  await expect(runs.last()).toHaveAttribute('aria-label', /27 Sep 2026.*success/);
  await expect(page.getByTestId('scout-findings')).toContainText('Four synthetic opportunities.');
  await expect(page.getByTestId('scout-findings').locator('script')).toHaveCount(0);
  // One Insights preview plus the opened detail view (preview exclusions are covered in insights.spec.ts).
  expect(api.scoutOutputRequests).toEqual(['learning', 'learning']);
  api.scouts.scouts = api.scouts.scouts.filter((entry) => entry.state === 'ok' && entry.status.runStatus === 'success');
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/scouts');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  expect((await (await refreshed).json()).scouts).toHaveLength(1);
  await expect(page.getByRole('button', { name: /scouts need attention/ })).toHaveCount(0);
});


test('five-column offers become labelled cards at 390px with relative freshness', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  const entry = api.scouts.scouts.find((entry) => entry.state === 'ok' && entry.status.scoutId === 'learning');
  if (entry?.state !== 'ok') throw new Error('missing fixture');
  entry.status.lastAttemptAt = '2026-09-27T08:38:02+02:00';
  entry.status.lastSuccessAt = '2026-09-26T06:51:00+02:00';
  entry.status.runStatus = 'failed';
  await api.install(page);
  await page.route('**/api/scouts/output', (route) => route.fulfill({ json: {
    status: 'ok', revision: 'a'.repeat(40), blobSha: 'b'.repeat(40), path: 'Discoveries/Offers.md',
    markdown: '| Item | Store | Price | Was | Until |\n| --- | --- | --- | --- | --- |\n| [Synthetic tea](https://example.com/tea) | Example shop | 12 DKK | 20 DKK | Sunday |\n| Coffee | Other shop | 30 DKK | 40 DKK | Monday |\n\n| A | B |\n| --- | --- |\n| uneven |',
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: '2 scouts need attention' }).click();
  const panel = page.getByRole('button', { name: /Learning opportunities/ });
  await expect(panel).toContainText('Last attempt 12 min ago');
  await expect(panel).toContainText('Last success Yesterday 06:51');
  await panel.click();
  const detail = page.locator('.scout-detail');
  await expect(detail.locator('dd').nth(0)).toHaveText('Yesterday 06:51');
  await expect(detail.locator('dd').nth(1)).toHaveText('12 min ago');
  expect(await detail.innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  const findings = page.getByTestId('scout-findings');
  const cards = findings.locator('.scout-table-cards tbody tr');
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card).toHaveCSS('display', 'block');
    for (const label of ['Item', 'Store', 'Price', 'Was', 'Until']) {
      await expect(card.locator(`[data-label="${label}"]`)).toBeVisible();
    }
    // Every value keeps its label, the first (title) column included.
    for (const label of ['Item', 'Price']) {
      expect(await card.locator(`[data-label="${label}"]`).evaluate((cell) =>
        getComputedStyle(cell, '::before').content.replace(/"\s*"/g, '').replaceAll('"', ''))).toBe(`${label}: `);
    }
  }
  await expect(findings.getByRole('link', { name: 'Synthetic tea' })).toHaveAttribute('href', 'https://example.com/tea');
  const fallback = findings.locator('.scout-table-scroll').last();
  await expect(fallback).toHaveCSS('overflow-x', 'auto');
  await expect(fallback.locator('.scout-table-cards')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(cards.first()).toHaveCSS('display', 'table-row');
});
