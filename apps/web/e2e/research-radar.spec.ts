import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { ApiError } from '@vault-companion/contracts';
import { goTo } from './nav.ts';

// UX7: Research Radar is its own screen, opened from Today's single research entry. Its behaviour (Keep/Remove, reads)
// is unchanged; only where it is mounted changed.
const openRadar = async (page: Page) => {
  await page.getByRole('button', { name: 'Research · 2 highlights', exact: true }).click();
};

test('a refused Radar decision can be discarded and stays cleared after reload', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  let attempts = 0;
  await page.route('**/api/radar/decisions', async (route) => {
    attempts += 1;
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify(ApiError.parse({
      code: 'invalid', message: 'Synthetic permanent decision refusal', retryable: false,
    })) });
  });
  await page.goto('/');
  await goTo(page, 'Today');
  await openRadar(page);
  const radar = page.getByRole('region', { name: 'Research Radar' });
  const cards = radar.getByTestId('radar-card');
  await expect(cards).toHaveCount(2);
  await cards.first().getByRole('button', { name: 'Remove', exact: true }).click();
  const discard = radar.getByRole('button', { name: 'Discard', exact: true });
  await expect(discard).toBeVisible();
  await expect(cards).toHaveCount(1);
  await discard.click();
  await expect(cards).toHaveCount(2);
  await expect(radar.getByTestId('radar-decision')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('vault-companion:radar-pending:'))
    .reduce((total, [, value]) => total + (JSON.parse(value) as unknown[]).length, 0))).toBe(0);
  await page.reload();
  await goTo(page, 'Today');
  await openRadar(page);
  await expect(cards).toHaveCount(2);
  await expect(radar.getByTestId('radar-decision')).toHaveCount(0);
  expect(attempts).toBe(1);
});

test('Research Radar opens from Today as its own screen, expands/collapses, reads a note and keeps decisions honest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  await openRadar(page);

  const radar = page.getByRole('region', { name: 'Research Radar' });
  await expect(radar).toBeVisible();
  // The dedicated screen opens expanded; the toggle still collapses and expands it.
  const toggle = radar.getByRole('button', { name: /^Research Radar(?:\s+[▸▾])?$/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(radar.getByTestId('radar-summary')).toHaveText('2 papers ranked this week');

  const cards = radar.getByTestId('radar-card');
  await expect(cards).toHaveCount(2);

  // The note-backed card reads inside the page; the source-backed card stays a plain link.
  await radar.getByRole('button', { name: 'Read', exact: true }).click();
  const note = radar.getByTestId('radar-note-view');
  await expect(note).toContainText('Graph retrieval on device');
  await expect(note).toContainText('Synthetic note body used only by the Radar e2e mock.');
  await note.getByRole('button', { name: 'Back to papers', exact: true }).click();

  await cards.first().getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(cards).toHaveCount(1);
  const removed = radar.getByTestId('radar-decision');
  await expect(removed).toContainText('Removed');
  await expect(removed.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await removed.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(radar.getByTestId('radar-decision')).toHaveCount(0);

  // Keep stays pending in this mock; the spec must never fabricate a Library save.
  await cards.first().getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(cards).toHaveCount(1);
  const kept = radar.getByTestId('radar-decision');
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText('Keep');
  await expect(kept).toContainText('Saving to Library pending');
  await expect(kept).not.toContainText('Saved to Library');
});
