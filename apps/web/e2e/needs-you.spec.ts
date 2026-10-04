import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('a degraded scout is never a Needs you row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  const learning = api.scouts.scouts.find((entry) => entry.state === 'ok' && entry.status.scoutId === 'learning');
  if (learning?.state !== 'ok') throw new Error('missing fixture');
  learning.status.runStatus = 'degraded';
  learning.status.lastError = 'one source timed out';
  api.scouts.scouts = [learning];
  await api.install(page);
  // Wait for the scouts read so "no line" cannot pass before the card has its data.
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/scouts');
  await page.goto('/');
  await loaded;
  await expect(page.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
});

test('a failed scout row shows its error, hides on Got it, and the line disappears for good', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const needsLine = page.getByRole('button', { name: /^Needs you/ });
  await expect(needsLine).toBeVisible();
  await needsLine.click();

  const sheet = page.getByRole('dialog', { name: 'Needs you' });
  const row = sheet.getByRole('button', { name: /City events/ });
  await expect(row).toContainText('runner could not start');
  await sheet.getByRole('button', { name: 'Got it' }).click();
  await expect(sheet.getByRole('button', { name: /City events/ })).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
  // Device-held: the dismissal survives a reload while the same error text persists.
  const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/scouts');
  await page.reload();
  await reloaded;
  await expect(page.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
});
