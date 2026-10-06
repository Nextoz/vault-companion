import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MorningBriefResponse } from '@vault-companion/contracts';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

// PW1: a manual tour that photographs every screen on the mocked app. Test tooling only: it never touches the live
// vault or a live API. Excluded from the default `pnpm e2e`/CI run unless VC_TOUR=1 (see playwright.config.ts).
const CLOCK = new Date('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';
const CALENDAR_TASK = 'Draft quarterly notes at 14:00';
const TOUR_DIR = fileURLToPath(new URL('../test-results/tour/', import.meta.url));

const brief = (date: string) => MorningBriefResponse.parse({
  revision: 'b'.repeat(40), date, generatedAt: `${date}T04:31:00+02:00`, source: 'fallback', unavailable: [],
  brief: { source: 'fallback', dayLine: 'Synthetic day', gaps: [], todos: [] },
});

const card = (rank: number, title: string, start: string) => ({
  eventId: rank.toString(16).padStart(20, '0'), rank, explore: false, resurfaced: false, summary: '', title, start, end: null,
  location: 'Synthetic hall', online: false, cost: 'Free', registration: { state: 'not-required' as const, deadline: null },
  aiScore: 80, why: 'Synthetic reason.', category: 'community', scouts: ['city-events'], sourceName: 'Synthetic source',
  sourceUrl: `https://example.org/${rank}`, calendar: { inCalendar: null, clash: null, freeThatEvening: true },
});

// SIWH renders only when the device already holds an older snapshot; seed one so the pane is part of the tour.
const seedOnce = (page: Page, snapshot: unknown) =>
  page.addInitScript((value) => {
    if (window.sessionStorage.getItem('tour-seeded') === '1') return;
    window.sessionStorage.setItem('tour-seeded', '1');
    window.localStorage.setItem('vc.sinceIWasHere', JSON.stringify(value));
  }, snapshot);

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

test('tour: photograph every screen on the mock app', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });

  const api = new MockApi();
  api.open = [taskView(10, 'Water the plants'), taskView(11, 'Call the bike shop'), taskView(3, CALENDAR_TASK)];
  api.morning = MockApi.SAMPLE_MORNING;
  api.morningBrief = brief(TODAY);
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-28T06:50:00+02:00',
    cards: [card(1, 'Synthetic event one', '2026-10-01T17:00:00+02:00'), card(2, 'Synthetic event two', '2026-10-02T17:00:00+02:00'),
      card(3, 'Synthetic event three', '2026-10-03T17:00:00+02:00')] };
  await seedOnce(page, { at: 1, triage: [], scouts: { learning: 1 }, brief: '2026-09-29', papers: [] });
  await api.install(page);
  await page.goto('/');

  mkdirSync(TOUR_DIR, { recursive: true });
  const shots: { file: string; screen: string }[] = [];
  const shot = async (name: string, fn: () => Promise<void>): Promise<void> => {
    const file = `${String(shots.length + 1).padStart(2, '0')}-${slug(name)}.png`;
    try {
      await fn();
      await page.screenshot({ path: join(TOUR_DIR, file) });
    } catch (error) {
      throw new Error(`tour: could not reach screen "${name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    shots.push({ file, screen: name });
  };

  await shot('Today - morning card', async () => {
    await goTo(page, 'Today');
    await expect(page.getByRole('region', { name: 'Today at a glance' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Morning Brief', exact: true })).toBeVisible();
  });

  await shot('Today - Needs You', async () => {
    const needs = page.getByRole('button', { name: /^Needs you/ });
    await needs.scrollIntoViewIfNeeded();
    await expect(needs).toBeVisible();
  });

  await shot('Today - Since I was here', async () => {
    const pane = page.getByRole('region', { name: 'Since I was here' });
    await pane.scrollIntoViewIfNeeded();
    await expect(pane).toBeVisible();
  });

  await shot('Today - AI usage panel', async () => {
    // UX8: the AI usage panel lives on the Today screen's Boards view (Overview is the default).
    await goTo(page, 'Board');
    const panel = page.getByRole('region', { name: 'AI usage', exact: true });
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('.ai-usage-tile')).toHaveCount(5);
  });

  await shot('Tasks', async () => {
    await goTo(page, 'Tasks');
    await expect(page.getByRole('region', { name: 'Today', exact: true }).getByText('Water the plants')).toBeVisible();
  });

  await shot('Scouts', async () => {
    await goTo(page, 'Scouts');
    await expect(page.getByRole('region', { name: 'Scouts', exact: true })).toBeVisible();
  });

  await shot('Notes', async () => {
    await goTo(page, 'Notes');
    await expect(page.getByRole('region', { name: 'Notes', exact: true })).toBeVisible();
  });

  const logView = page.getByRole('group', { name: 'Log view' });
  await shot('Log - Training', async () => {
    await goTo(page, 'Log');
    await expect(page.getByRole('region', { name: 'Training sessions' })).toBeVisible();
  });
  await shot('Log - Progress', async () => {
    await logView.getByRole('button', { name: 'Progress', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Progress', exact: true })).toBeVisible();
  });
  await shot('Log - Health', async () => {
    await logView.getByRole('button', { name: 'Health', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Health', exact: true })).toBeVisible();
  });
  await shot('Log - Learning', async () => {
    await logView.getByRole('button', { name: 'Learning', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Learning sessions' })).toBeVisible();
  });

  await shot('Status sheet', async () => {
    await goTo(page, 'Status');
    await expect(page.getByRole('list', { name: 'AI budget' })).toContainText('Claude weekly');
  });

  await shot('Needs You sheet', async () => {
    await goTo(page, 'Today');
    await page.getByRole('button', { name: /^Needs you/ }).click();
    await expect(page.getByRole('dialog', { name: 'Needs you' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Needs you' }).getByRole('button', { name: 'Close' }).click();

  await shot('Add to Calendar sheet', async () => {
    await goTo(page, 'Tasks');
    await page.getByRole('button', { name: `Add to Calendar: ${CALENDAR_TASK}` }).click();
    await expect(page.getByRole('dialog', { name: 'Add to Calendar' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Add to Calendar' }).getByRole('button', { name: 'Cancel' }).click();

  await shot('Add', async () => {
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Capture', exact: true })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Capture', exact: true }).getByRole('button', { name: 'Close' }).click();

  await shot('Report', async () => {
    await page.getByRole('button', { name: 'Report a bug or wish', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Report', exact: true })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Report', exact: true }).getByRole('button', { name: 'Cancel' }).click();

  const index = [
    '# Tour screenshots',
    '',
    `390x844 (iPhone 15 WebKit), frozen clock ${CLOCK.toISOString()}, synthetic mock data only.`,
    '',
    '| File | Screen |',
    '| --- | --- |',
    ...shots.map(({ file, screen }) => `| ${file} | ${screen} |`),
    '',
  ].join('\n');
  writeFileSync(join(TOUR_DIR, 'index.md'), index);
});
