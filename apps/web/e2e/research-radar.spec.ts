import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('Radar mounts on Scouts, expands/collapses, reads a note and keeps decisions honest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Scouts', exact: true }).click();

  const radar = page.getByRole('region', { name: 'Research Radar' });
  await expect(radar).toBeVisible();
  const toggle = radar.getByRole('button', { name: 'Research Radar', exact: true });
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
