import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('one app switch (focus + visibilitychange + online) makes one read; the next switch and Refresh read again', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi();
  await api.install(page);
  let sessions = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/session') sessions++;
  });
  await page.goto('/');
  // UX8: Today's large sync block is gone; the Vault status details live on the other tabs.
  await goTo(page, 'Tasks');
  const refresh = page.getByRole('button', { name: 'Refresh vault' });
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Vault status' })).toContainText('Checked');
  const before = { tasks: api.taskReads, sessions };
  const burst = () => page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await burst();
  await expect.poll(() => api.taskReads).toBe(before.tasks + 1);
  await expect(refresh).toBeEnabled();
  // Allow every event continuation and routed request to settle: still exactly one read for the burst.
  await page.waitForTimeout(200);
  expect(api.taskReads).toBe(before.tasks + 1);
  expect(sessions).toBe(before.sessions + 1);
  await burst();
  await expect.poll(() => api.taskReads).toBe(before.tasks + 2);
  await refresh.click();
  await expect.poll(() => api.taskReads).toBe(before.tasks + 3);
});

test('shows vault state, refreshes once, and preserves the last check after a failure', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-26T12:10:00Z') });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  // UX8: Today's large sync block is gone; the Vault status details live on the other tabs.
  await goTo(page, 'Tasks');
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
  // UX8: Today's large sync block is gone; the Vault status details live on the other tabs.
  await goTo(page, 'Tasks');
  const status = page.getByRole('region', { name: 'Vault status' });
  await expect(status).toContainText('Vault revision 0000000');
  await expect(status).toContainText('Checked 14:10');
  const count = api.taskReads;
  await page.clock.fastForward(10 * 60 * 1000 + 1000);
  await expect(status).toContainText('Not refreshed since 14:10');
  expect(api.taskReads).toBe(count);
});

test('the Vault status details list the last read time per route (SP measure), without queries', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  // UX8: Today's large sync block is gone; the Vault status details live on the other tabs.
  await goTo(page, 'Tasks');
  const status = page.getByRole('region', { name: 'Vault status' });
  await expect(status).toContainText('Checked');
  await status.locator('summary').click();
  const speed = status.getByRole('list', { name: 'Read speed' });
  await expect(speed.getByRole('listitem').filter({ hasText: /^\/api\/tasks total \d+ ms \(median \d+, n=\d+\)/ })).toHaveCount(1);
  await expect(speed).not.toContainText('?');
  await page.screenshot({ path: test.info().outputPath('sp1-read-speed-390x844.png') });
});

test('the Status sheet renders the AI budget rows', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  // UX8: Today's large sync block is gone; the Vault status details live on the other tabs.
  await goTo(page, 'Tasks');
  await goTo(page, 'Status');
  await expect(page.getByRole('list', { name: 'AI budget' })).toContainText('Claude weekly');
});
