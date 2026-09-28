import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('scout insights show totals, picks, states and bounded parallel previews at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  const learning = api.scouts.scouts.find((entry) => entry.state === 'ok' && entry.status.scoutId === 'learning');
  if (learning?.state !== 'ok') throw new Error('missing fixture');
  for (let index = 1; index <= 6; index++) api.scouts.scouts.push({
    state: 'ok', file: `extra-${index}.json`, status: {
      ...learning.status,
      scoutId: `extra-${index}`,
      displayName: `Extra scout ${index}`,
      findings: 1,
      latestOutput: `Discoveries/Extra-${index}.md`,
      history: [{ at: `2026-09-${20 + index}T07:00:00+02:00`, status: 'success', findings: 1 }],
    },
  });
  // Failed and stale scouts carry an output path, so the "never previewed" guard is really exercised.
  const failed = api.scouts.scouts.find((entry) => entry.state === 'ok' && entry.status.scoutId === 'city-events');
  if (failed?.state !== 'ok') throw new Error('missing fixture');
  failed.status.latestOutput = 'Discoveries/City events.md';
  api.scouts.scouts.push({ state: 'ok', file: 'stale.json', status: {
    ...learning.status, scoutId: 'stale', displayName: 'Stale scout', findings: 0, latestOutput: 'Discoveries/Stale.md',
    lastAttemptAt: '2026-09-20T07:00:00+02:00', lastSuccessAt: '2026-09-20T07:00:00+02:00',
    history: [{ at: '2026-09-20T07:00:00+02:00', status: 'success', findings: 0 }],
  } });
  // One read that never settles must not hold the other cards at "Loading".
  api.scoutOutputGates.set('extra-1', new Promise(() => {}));
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: '2 scouts need attention' }).click();

  const insights = page.locator('.insights');
  await expect(insights.getByRole('heading', { name: 'What your scouts found' })).toBeVisible();
  await expect(insights).toContainText('10 findings');
  await expect(insights.getByRole('img')).toHaveAttribute('aria-label', /2026-09-27: 10/);

  const learningCard = insights.getByRole('article', { name: 'Learning opportunities' });
  await expect(learningCard.getByRole('listitem')).toHaveCount(3);
  await expect(learningCard).toContainText('Platform workshop');
  await expect(learningCard).toContainText('Provider: Example Guild');
  await expect(learningCard.getByRole('link', { name: 'Platform workshop' })).toHaveAttribute('target', '_blank');
  await expect(learningCard.getByRole('link', { name: 'Platform workshop' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(learningCard).not.toContainText('Findings unavailable');

  const failedCard = insights.getByRole('article', { name: 'City events' });
  await expect(failedCard).toContainText('Failed');
  await expect(failedCard).not.toContainText('Loading findings');
  await expect(insights.getByRole('article', { name: 'Extra scout 1' })).toContainText('Loading findings');
  await expect(insights.getByRole('article', { name: 'Extra scout 2' })).toContainText('Findings unavailable');
  await expect(insights.getByRole('article', { name: 'Stale scout' })).toContainText('Stale');
  await expect(insights.getByRole('article', { name: 'Extra scout 6' })).toContainText('Open scout to see findings');
  // At most six scouts are previewed; a fresh scouts response retries only unavailable reads, never a success
  // (learning) or one still in flight (extra-1).
  expect(new Set(api.scoutOutputRequests).size).toBe(6);
  expect(api.scoutOutputRequests.filter((id) => id === 'learning')).toHaveLength(1);
  expect(api.scoutOutputRequests.filter((id) => id === 'extra-1')).toHaveLength(1);
  expect(api.scoutOutputRequests).not.toContain('city-events');
  expect(api.scoutOutputRequests).not.toContain('stale');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await learningCard.getByRole('button', { name: 'See all' }).click();
  await expect(page.locator('.scout-detail').getByRole('heading', { name: 'Learning opportunities' })).toBeVisible();
  await expect(page.getByTestId('scout-findings')).toContainText('Four synthetic opportunities.');
});
