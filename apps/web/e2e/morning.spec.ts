import { MorningBriefMissingResponse, MorningBriefResponse } from '@vault-companion/contracts';
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

// UX7: the card leads with a Morning Brief button (the guided "Review my morning" is gone), one research entry opens
// Research Radar as its own screen, and the reading brief/explained papers live in the sheet's Reading section.
const CLOCK = new Date('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';

const brief = (over: Partial<MorningBriefResponse['brief']> = ({})) => MorningBriefResponse.parse({
  revision: 'b'.repeat(40), date: TODAY, generatedAt: `${TODAY}T04:31:00+02:00`, source: 'model', unavailable: [],
  brief: { source: 'model', dayLine: 'A calm synthetic day.', gaps: [], todos: [], ...over },
});

test('Today: the Morning Brief button opens the whole brief, the Reading section and the Radar link', async ({ page }) => {
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  api.morning = MockApi.SAMPLE_MORNING;
  api.morningBrief = brief({ stateLine: 'Low battery.',
    gaps: [{ blockIndex: 1, start: `${TODAY}T09:00:00+02:00`, end: `${TODAY}T10:30:00+02:00`, suggestion: 'Deep work' }],
    todos: [{ id: 1, text: 'Pay the bill', due: TODAY, bill: true, firstStep: 'Open the banking app' }],
    encouragement: 'One thing at a time.' });
  await api.install(page);
  await page.goto('/');

  // The old guided review is gone; the card leads with a Morning Brief button.
  await expect(page.getByRole('button', { name: 'Review my morning' })).toHaveCount(0);
  const open = page.getByRole('button', { name: 'Morning Brief', exact: true });
  await expect(open).toBeVisible();
  await open.click();
  const sheet = page.getByRole('dialog', { name: 'Morning Brief' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('A calm synthetic day.');
  await expect(sheet).toContainText('Low battery.');
  await expect(sheet).toContainText('09:00-10:30  Deep work');
  await expect(sheet).toContainText('Pay the bill - Open the banking app');
  await expect(sheet).toContainText('One thing at a time.');
  // Reading section: the same reading brief and explanations the removed card line summarised, plus the Radar link.
  await expect(sheet.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible();
  await expect(sheet.getByTestId('morning-summary')).toHaveText('Reading brief · 1 explained · 1 pending');
  await expect(sheet.getByRole('link', { name: 'Synthetic Sparse Routing' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Research Radar', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Morning Brief' })).toHaveCount(0);
});

test('Today: no brief shows the reason, and one research entry opens Radar in one tap', async ({ page }) => {
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = new MockApi();
  api.morning = MockApi.SAMPLE_MORNING;
  api.morningBrief = MorningBriefMissingResponse.parse({ kind: 'missing', revision: 'b'.repeat(40), statusError: 'not-written:precondition-failed' });
  await api.install(page);
  await page.goto('/');

  // No brief today: the sheet carries the job's fixed reason, never free text.
  await page.getByRole('button', { name: 'Morning Brief', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Morning Brief' });
  await expect(sheet).toContainText('No brief yet - not-written:precondition-failed');
  await expect(sheet.getByRole('button', { name: 'Research Radar', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();

  // The card no longer shows a separate "Reading brief · N explained" line.
  await expect(page.getByRole('button', { name: /Reading brief/ })).toHaveCount(0);
  // One research entry; one tap opens Research Radar as its own screen, with the papers already shown.
  const research = page.getByRole('button', { name: 'Research · 2 highlights', exact: true });
  await expect(research).toBeVisible();
  await research.click();
  const radar = page.getByRole('region', { name: 'Research Radar' });
  await expect(radar).toBeVisible();
  await expect(radar.getByTestId('radar-card')).toHaveCount(2);
});
