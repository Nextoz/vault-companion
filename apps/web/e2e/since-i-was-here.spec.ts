import { MorningBriefResponse } from '@vault-companion/contracts';
import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';

// SIWH is device-held only: the spec seeds an older snapshot in localStorage, then checks that exactly the sources
// that moved up are listed, and that closing the pane advances the snapshot until something newer arrives.
const CLOCK = new Date('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';

const card = (rank: number, title: string, start: string) => ({
  eventId: rank.toString(16).padStart(20, '0'), rank, explore: false, resurfaced: false, summary: '', title, start, end: null,
  location: 'Synthetic hall', online: false, cost: 'Free', registration: { state: 'not-required' as const, deadline: null },
  aiScore: 80, why: 'Synthetic reason.', category: 'community', scouts: ['city-events'], sourceName: 'Synthetic source',
  sourceUrl: `https://example.org/${rank}`, calendar: { inCalendar: null, clash: null, freeThatEvening: true },
});

const brief = (date: string) => MorningBriefResponse.parse({
  revision: 'b'.repeat(40), date, generatedAt: `${date}T04:31:00+02:00`, source: 'fallback', unavailable: [],
  brief: { source: 'fallback', dayLine: 'Synthetic day', gaps: [], todos: [] },
});

const withReads = (api: MockApi) => {
  api.morning = MockApi.SAMPLE_MORNING;
  api.morningBrief = brief(TODAY);
  return api;
};

const seedOnce = (page: Page, snapshot: unknown) =>
  page.addInitScript((value) => {
    if (window.sessionStorage.getItem('siwh-seeded') === '1') return;
    window.sessionStorage.setItem('siwh-seeded', '1');
    window.localStorage.setItem('vc.sinceIWasHere', JSON.stringify(value));
  }, snapshot);

test('a first run shows nothing and only stores the baseline', async ({ page }) => {
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = withReads(new MockApi());
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-28T06:50:00+02:00',
    cards: [card(1, 'Synthetic event one', '2026-10-01T17:00:00+02:00'), card(2, 'Synthetic event two', '2026-10-02T17:00:00+02:00')] };
  await api.install(page);
  await page.goto('/');

  // Wait for the Today reads to land (the morning line proves the card rendered), then the pane is still silent.
  await expect(page.getByRole('button', { name: /Reading brief/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Since I was here' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('vc.sinceIWasHere'))).not.toBeNull();
  const stored = JSON.parse((await page.evaluate(() => window.localStorage.getItem('vc.sinceIWasHere')))!);
  expect(stored).toMatchObject({ triage: 2, brief: TODAY, scouts: { learning: 4 } });
});

test('an older snapshot lists exactly the new items, and it stays closed until something newer arrives', async ({ page }) => {
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = withReads(new MockApi());
  const cards = [card(1, 'Synthetic event one', '2026-10-01T17:00:00+02:00'), card(2, 'Synthetic event two', '2026-10-02T17:00:00+02:00'),
    card(3, 'Synthetic event three', '2026-10-03T17:00:00+02:00')];
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-28T06:50:00+02:00', cards };
  await api.install(page);
  await seedOnce(page, { at: 1, triage: 0, scouts: { learning: 1 }, brief: '2026-09-29', papers: [] });
  await page.goto('/');

  const pane = page.getByRole('region', { name: 'Since I was here' });
  await expect(pane.locator('.siwh-line')).toHaveText([
    '3 events in triage', 'Learning opportunities \u00b7 3 new findings', 'New morning brief', '2 new explained papers',
  ]);

  await pane.getByRole('button', { name: 'Dismiss all' }).click();
  await expect(page.getByRole('region', { name: 'Since I was here' })).toHaveCount(0);
  // Closing stored the snapshot: a reload shows nothing while nothing has changed.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Since I was here' })).toHaveCount(0);

  api.triage = { ...api.triage, cards: [card(4, 'Synthetic event four', '2026-10-04T17:00:00+02:00'), ...cards] };
  await page.reload();
  await expect(page.getByRole('region', { name: 'Since I was here' }).locator('.siwh-line')).toHaveText(['1 event in triage']);
});
