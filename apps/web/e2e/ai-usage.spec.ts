import { expect, test } from '@playwright/test';
import { AiUsageResponse } from '@vault-companion/contracts';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('AB3b: the AI usage panel shows one tile per provider with its budget left line and a 7 d / 30 d toggle', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const panel = page.getByRole('region', { name: 'AI usage', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.ai-usage-tile')).toHaveCount(5);
  await expect(panel.locator('.ai-usage-tile', { hasText: 'Claude Code' }).locator('.ai-usage-left')).toHaveText('58 % used');
  await expect(panel.locator('.ai-usage-tile', { hasText: 'Scaleway' }).locator('.ai-usage-left')).toHaveText('$6.14 left');
  await expect(panel.locator('.ai-usage-tile', { hasText: 'Jev' }).locator('.ai-usage-left')).toHaveCount(0);
  await expect(panel.locator('.ai-usage-updated')).toContainText('Updated 13:45');
  await expect(panel.locator('.ai-usage-spark').first()).toBeVisible();
  await panel.getByRole('button', { name: '30 d', exact: true }).click();
  await expect(panel.getByRole('button', { name: '30 d', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('button', { name: '7 d', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('AB3b: an unknown provider still gets a tile titled with its id', async ({ page }) => {
  const api = new MockApi();
  api.aiUsage = AiUsageResponse.parse({
    ...api.aiUsage,
    providers: {
      ...api.aiUsage.providers,
      mystery: { days: [{ date: '2026-09-30', calls: 2, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0 }] },
    },
  });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const panel = page.getByRole('region', { name: 'AI usage', exact: true });
  await expect(panel.locator('.ai-usage-tile', { hasText: 'mystery' })).toHaveCount(1);
});
