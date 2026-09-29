import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('This morning: one line on Today, expands to the brief and the explanations at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  api.morning = MockApi.SAMPLE_MORNING;
  await api.install(page);
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'This morning', exact: true });
  await expect(panel.getByTestId('morning-summary')).toHaveText('Reading brief · 1 explained · 1 pending');
  await expect(panel.getByText('Synthetic Sparse Routing')).toHaveCount(0);

  await panel.getByRole('button', { name: /^This morning/ }).click();
  await expect(panel.getByRole('link', { name: 'Synthetic Sparse Routing' })).toBeVisible();
  const explained = panel.getByTestId('morning-explained');
  await expect(explained).toHaveCount(2);
  await expect(explained.nth(1)).toContainText('Synthetic Graph Study · pending');
  await explained.first().locator('summary').click();
  await expect(explained.first()).toContainText('A synthetic plain explanation.');
  await expect(explained.first()).not.toContainText('type: research-explained');

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(panel).toHaveCount(0);
});
