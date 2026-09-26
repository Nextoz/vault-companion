import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('coalesces a wake burst and cooldown while Refresh still reads', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi();
  await api.install(page);
  let sessions = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/session') sessions++;
  });
  await page.goto('/');
  const refresh = page.getByRole('button', { name: 'Refresh vault' });
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Vault status' })).toContainText('Checked');
  await page.clock.runFor(1100);
  const before = { tasks: api.taskReads, sessions };
  const burst = () => page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await burst();
  await expect.poll(() => api.taskReads).toBe(before.tasks + 1);
  await expect(refresh).toBeEnabled();
  await burst();
  // Allow every event continuation and routed request to settle, still inside cooldown.
  await page.waitForTimeout(200);
  expect(api.taskReads).toBe(before.tasks + 1);
  expect(sessions).toBe(before.sessions + 1);
  await refresh.click();
  await expect.poll(() => api.taskReads).toBe(before.tasks + 2);
});

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
