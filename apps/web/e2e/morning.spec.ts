import { MorningBriefMissingResponse, MorningBriefResponse } from '@vault-companion/contracts';
import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

// UX9: Today opens only the brief; Radar retains the existing reading view.
const CLOCK = new Date('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';

const brief = (over: Partial<MorningBriefResponse['brief']> = ({})) => MorningBriefResponse.parse({
  revision: 'b'.repeat(40), date: TODAY, generatedAt: `${TODAY}T04:31:00+02:00`, source: 'model', unavailable: [],
  brief: { source: 'model', dayLine: 'A calm synthetic day.', gaps: [], todos: [], ...over },
});

test('Today: the Morning Brief button opens only the whole brief and restores focus', async ({ page }) => {
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
  await expect(sheet.getByText('This morning', { exact: true })).toHaveCount(0);
  await expect(sheet.getByText('Reading', { exact: true })).toHaveCount(0);
  await expect(sheet.getByTestId('morning-summary')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Morning Brief' })).toHaveCount(0);
  await expect(open).toBeFocused();
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
  await expect(sheet.getByRole('button', { name: 'Research Radar', exact: true })).toHaveCount(0);
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

for (const colorScheme of ['light', 'dark'] as const) {
  test(`long brief keeps Close tappable at both scroll ends (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.clock.install({ time: CLOCK });
    await page.setViewportSize({ width: 390, height: 844 });
    const api = new MockApi();
    api.morning = MockApi.SAMPLE_MORNING;
    api.morningBrief = brief({
      dayLine: 'A full synthetic day. '.repeat(40),
      stateLine: 'Take a steady pace. '.repeat(40),
      encouragement: 'One step at a time. '.repeat(40),
    });
    await api.install(page);
    await page.goto('/');
    const opener = page.getByRole('button', { name: 'Morning Brief', exact: true });
    const sheet = page.getByRole('dialog', { name: 'Morning Brief' });
    const close = sheet.getByRole('button', { name: 'Close', exact: true });
    for (const bottom of [false, true]) {
      await opener.click();
      await expect(sheet).toContainText('A full synthetic day.');
      if (bottom) {
        await sheet.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        expect(await sheet.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      }
      const box = await close.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      // A trial click checks hit testing without scrolling an offscreen control into view first.
      await close.click({ trial: true });
      await close.click();
      await expect(sheet).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
    await page.getByRole('button', { name: /Research ·|No research highlights/ }).click();
    const radar = page.getByRole('region', { name: 'Research Radar' });
    await radar.getByRole('button', { name: 'Reading', exact: true }).click();
    await expect(radar.getByTestId('morning-summary')).toHaveText('Reading brief · 1 explained · 1 pending');
    await expect(radar.getByRole('link', { name: 'Synthetic Sparse Routing' })).toBeVisible();
    await expect(radar.getByTestId('morning-explained')).toHaveCount(2);
  });
}

test('brief can close while loading, after failure, and with a stale file', async ({ page }) => {
  await page.clock.install({ time: CLOCK });
  const api = new MockApi();
  await api.install(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/morning-brief', async (route) => {
    await pending;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/');
  const opener = page.getByRole('button', { name: 'Morning Brief', exact: true });
  const sheet = page.getByRole('dialog', { name: 'Morning Brief' });
  await opener.click();
  await expect(sheet).toContainText('Loading brief');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(opener).toBeFocused();
  release();
  await opener.click();
  await expect(sheet).toContainText('Brief unavailable');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(opener).toBeFocused();
  await page.unroute('**/api/morning-brief');
  await page.route('**/api/morning-brief', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(api.morningBrief),
  }));
  await page.reload();
  await opener.click();
  await expect(sheet).toContainText('No brief yet');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
});
