import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('a degraded scout is never a Needs you row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  const learning = api.scouts.scouts.find((entry) => entry.state === 'ok' && entry.status.scoutId === 'learning');
  if (learning?.state !== 'ok') throw new Error('missing fixture');
  learning.status.runStatus = 'degraded';
  learning.status.lastError = 'one source timed out';
  // A stale peer renders the card's scouts line, so the read has visibly landed before the absence below is checked.
  const stale = { state: 'ok' as const, file: 'stale.json', status: { ...learning.status, scoutId: 'stale',
    displayName: 'Stale scout', runStatus: 'success' as const,
    lastAttemptAt: '2026-09-01T07:00:00+02:00', lastSuccessAt: '2026-09-01T07:00:00+02:00' } };
  api.scouts.scouts = [learning, stale];
  await api.install(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '1 scout needs attention' })).toBeVisible();
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
  // The Failed scout's line proves the card rendered its read while the dismissed row stays hidden.
  await expect(page.getByRole('button', { name: '1 scout needs attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
  // Device-held: the dismissal survives a reload while the same error text persists.
  await page.reload();
  await expect(page.getByRole('button', { name: '1 scout needs attention' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Needs you/ })).toHaveCount(0);
});
