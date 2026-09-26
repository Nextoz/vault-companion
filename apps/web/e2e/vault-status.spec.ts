import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('shows vault state, refreshes once, and preserves the last check after a failure', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-26T12:10:00Z') });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const status = page.getByRole('region', { name: 'Vault status' });
  await expect(status).toContainText('Vault updated 14:07 · from desktop');
  await expect(status).toContainText('Checked 14:10');
  const refresh = page.getByRole('button', { name: 'Refresh vault' });
  await expect(refresh).toBeEnabled();
  expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await status.locator('summary').click();
  await expect(status).toContainText(/Vault [a-f0-9]{12}/);
  await expect(status).toContainText(/App [a-f0-9]+ · built/);
  const count = api.taskReads;
  await page.clock.setSystemTime(new Date('2026-09-26T12:11:00Z'));
  await refresh.click();
  await expect(status).toContainText('Checked 14:11');
  expect(api.taskReads).toBe(count + 1);
  api.tasksMode = 'error';
  await refresh.click();
  await expect(status).toContainText('Not refreshed since 14:11');
  await expect(status.locator('.chip-attention')).toHaveText('Not refreshed since 14:11');
  await expect(refresh).toBeEnabled();
  api.tasksMode = 'hang';
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute('aria-busy', 'true');
});

test('ages without fetching and falls back to revision when metadata is absent', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-26T12:10:00Z') });
  const api = new MockApi();
  api.vault = null;
  await api.install(page);
  await page.goto('/');
  const status = page.getByRole('region', { name: 'Vault status' });
  await expect(status).toContainText('Vault revision 0000000');
  await expect(status).toContainText('Checked 14:10');
  const count = api.taskReads;
  await page.clock.fastForward(10 * 60 * 1000 + 1000);
  await expect(status).toContainText('Not refreshed since 14:10');
  expect(api.taskReads).toBe(count);
});
