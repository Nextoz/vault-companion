import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MorningBriefResponse } from '@vault-companion/contracts';
import { ACCOUNT, MockApi, taskView } from './mock-api.ts';
import { seenKey } from '../src/achievements.ts';
import { goTo } from './nav.ts';
import { leaderboardFixture } from './leaderboard-fixture.ts';

// PW1: a manual tour that photographs every screen on the mocked app. Test tooling only: it never touches the live
// vault or a live API. Excluded from the default `pnpm e2e`/CI run unless VC_TOUR=1 (see playwright.config.ts).
const CLOCK = new Date('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';
const CALENDAR_TASK = 'Draft quarterly notes at 14:00';
const NEXT_TASK = 'Prepare the quarterly project update and review the outstanding actions before the team meeting';
const TOUR_DIR = fileURLToPath(new URL('../test-results/tour/', import.meta.url));

const brief = (date: string) => MorningBriefResponse.parse({
  revision: 'b'.repeat(40), date, generatedAt: `${date}T04:31:00+02:00`, source: 'fallback',
  unavailable: ['mail'], unavailableReasons: { mail: 'google-reauth-needed' },
  brief: { source: 'fallback', dayLine: 'Synthetic day', gaps: [],
    meetings: [
      { title: 'Planning day', start: `${date}T00:00:00+02:00`, end: `${date}T23:59:00+02:00`, allDay: true, clash: false },
      { title: 'Design review with a deliberately long synthetic meeting title that wraps on a phone', start: `${date}T09:00:00+02:00`, end: `${date}T10:00:00+02:00`, allDay: false, clash: true, clashWith: 'Team catch-up', link: 'https://calendar.google.com/calendar/event?eid=synthetic-design' },
      { title: 'Team catch-up', start: `${date}T09:30:00+02:00`, end: `${date}T10:30:00+02:00`, allDay: false, clash: true, clashWith: 'Design review', link: 'https://calendar.google.com/calendar/event?eid=synthetic-team' },
    ], todos: [{ id: 0, text: 'Send synthetic notes', due: '2026-09-27', bill: false, overdueDays: 3 }] },
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
    window.localStorage.setItem('vc.sinceIWasHere', JSON.stringify(value.snapshot));
    // GAM1-C: mark the default fixture's earned achievements seen, so its summary toast stays out of the tour shots.
    window.localStorage.setItem(value.seenKey, JSON.stringify(['a1', 'a2', 'a3']));
  }, { snapshot, seenKey: seenKey(ACCOUNT) });

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

test('tour: photograph every screen on the mock app', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: CLOCK });
  await page.setViewportSize({ width: 390, height: 844 });

  const api = new MockApi();
  api.open = [taskView(10, NEXT_TASK), taskView(11, 'Call the bike shop'), taskView(3, CALENDAR_TASK)];
  // R4: Active Work on the Tasks shot (the quest-log cue outside Character).
  api.activeWork = '## Now';
  api.activeWorkItems = [
    { name: 'Garden plan', outcome: null, next: 'Order seeds', review: '2026-09-28', link: null, needsReview: true,
      locator: { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 3,
        lineText: '- [ ] **Garden plan:** Next: Order seeds ⏳ 2026-09-28', occurrencesAtRead: 1 } },
    { name: 'Bike repair', outcome: null, next: 'Call the shop about the brake cable', review: '2026-10-07', link: null, needsReview: false,
      locator: { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 4,
        lineText: '- [ ] **Bike repair:** Next: Call the shop about the brake cable ⏳ 2026-10-07', occurrencesAtRead: 1 } },
  ];
  api.morning = MockApi.SAMPLE_MORNING;
  api.morningBrief = brief(TODAY);
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-28T06:50:00+02:00',
    cards: [card(1, 'Synthetic event one', '2026-10-01T17:00:00+02:00'), card(2, 'Synthetic event two', '2026-10-02T17:00:00+02:00'),
      card(3, 'Synthetic event three', '2026-10-03T17:00:00+02:00')] };
  await seedOnce(page, { at: 1, triage: [], scouts: { learning: 1 }, brief: '2026-09-29', papers: [] });
  await api.install(page);
  await page.route('**/api/leaderboard', route => route.fulfill({ json: leaderboardFixture(CLOCK.toISOString()) }));
  await page.goto('/');

  mkdirSync(TOUR_DIR, { recursive: true });
  const shots: { file: string; screen: string }[] = [];
  const shot = async (name: string, fn: () => Promise<void>): Promise<void> => {
    const file = `${String(shots.length + 1).padStart(2, '0')}-${slug(name)}.png`;
    try {
      await fn();
      await page.screenshot({ path: join(TOUR_DIR, file), animations: 'disabled' });
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

  await shot('Morning Brief', async () => {
    await page.getByRole('button', { name: 'Morning Brief', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Morning Brief' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Morning Brief' }).getByRole('button', { name: 'Close', exact: true }).click();

  await shot('Today - Needs You', async () => {
    const needs = page.getByRole('button', { name: /^Needs you/ });
    await needs.click();
    await expect(page.getByRole('dialog', { name: 'Needs you', exact: true })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Needs you', exact: true }).getByRole('button', { name: 'Close' }).click();

  await shot('Today - Since I was here', async () => {
    const pane = page.getByRole('region', { name: 'Since I was here' });
    await pane.scrollIntoViewIfNeeded();
    await pane.getByRole('button', { name: /^Since I was here/ }).click();
    await expect(pane.getByRole('button', { name: 'Dismiss all', exact: true })).toBeVisible();
  });

  await shot('Today - AI usage panel', async () => {
    // UX8: the AI usage panel lives on the Today screen's Boards view (Overview is the default). Collapsed by
    // default: one compact summary row per provider.
    await goTo(page, 'Board');
    const panel = page.getByRole('region', { name: 'AI usage', exact: true });
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator('.ai-usage-row')).toHaveCount(5);
  });

  await shot('Today - AI usage panel expanded', async () => {
    const panel = page.getByRole('region', { name: 'AI usage', exact: true });
    await panel.scrollIntoViewIfNeeded();
    await panel.getByRole('button', { name: 'AI usage', exact: true }).click();
    await expect(panel.locator('.ai-usage-tile')).toHaveCount(5);
  });

  await shot('Board - AI model leaderboard', async () => {
    const panel = page.getByRole('region', { name: 'AI models', exact: true });
    await panel.evaluate(card => window.scrollBy(0, card.getBoundingClientRect().top - 100));
    await expect(panel.getByRole('listitem')).toHaveCount(10);
  });
  await shot('AI model - details', async () => {
    await page.getByRole('button', { name: /Synthetic Model 00/ }).click();
    await expect(page.getByRole('dialog', { name: 'Synthetic Model 00' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Synthetic Model 00' }).getByRole('button', { name: 'Close', exact: true }).click();

  // WX1: the week overview (mockup W3) and one day's meteogram (W1), on the Board's Weather card.
  const weather = page.getByRole('region', { name: 'Dashboard', exact: true }).getByRole('article', { name: 'Weather', exact: true });
  // Card top under the sticky status bar (about 90 px), like a person scrolling to it.
  const scrollCardTop = () => weather.evaluate((card) => window.scrollBy(0, card.getBoundingClientRect().top - 100));
  await shot('Weather - week', async () => {
    await scrollCardTop();
    await expect(weather.locator('.weather-week-row')).toHaveCount(7);
  });

  await shot('Weather - day meteogram', async () => {
    await weather.locator('.weather-week-row').first().click();
    await scrollCardTop();
    await expect(weather.locator('.weather-day-run')).toBeVisible();
  });
  await weather.getByRole('button', { name: 'Back', exact: true }).click();

  await shot('Tasks', async () => {
    await goTo(page, 'Tasks');
    await expect(page.getByRole('region', { name: 'Today', exact: true }).getByText(NEXT_TASK)).toBeVisible();
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

  // GAM1-B plan screens 1-2: the card, then the Character sheet at rest and scrolled (header must cover nothing).
  const character = page.getByRole('dialog', { name: 'Character' });
  await shot('Log - Character card', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole('button', { name: 'Open Character' })).toBeVisible();
  });
  await shot('Character sheet', async () => {
    await page.getByRole('button', { name: 'Open Character' }).click();
    await expect(character.locator('.character-hero')).toBeVisible();
  });
  await shot('Character sheet - scrolled', async () => {
    await character.evaluate((sheet) => { sheet.scrollTop = sheet.scrollHeight; });
    await expect(character.locator('.sheet-header')).toHaveAttribute('data-scrolled');
  });
  await shot('Character - How XP works', async () => {
    await character.getByRole('button', { name: 'How XP works' }).click();
    await expect(character.getByRole('button', { name: /Back/ })).toBeVisible();
  });

  // GAM1-C plan screens 3-4 and 6: the Achievements page, the badge detail and the toast, with the rich fixture.
  api.gameAchievements = true;
  await character.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Open Character' }).click();
  await shot('Character - Achievements', async () => {
    await character.getByRole('button', { name: 'All achievements' }).click();
    await expect(character.getByRole('heading', { name: 'Feats of Strength · 0 pts' })).toBeVisible();
  });
  await shot('Character - Achievements scrolled (Walking)', async () => {
    await character.evaluate((sheet) => { sheet.scrollTop = sheet.scrollHeight; });
    await expect(character.getByText('Points only, no XP · no daily goal, no streak')).toBeVisible();
  });
  await shot('Achievement detail', async () => {
    await character.evaluate((sheet) => { sheet.scrollTop = 0; });
    await character.locator('.achievement-tile', { hasText: 'First Flag' }).click();
    await expect(page.getByRole('dialog', { name: 'First Flag' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'First Flag' }).getByRole('button', { name: 'Close' }).click();
  // R2: Close slides the sheet out before it closes; Escape must reach the Character sheet, not the leaving detail.
  await expect(page.getByRole('dialog', { name: 'First Flag' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await character.getByRole('button', { name: 'Close' }).click();
  await shot('Achievement banner', async () => {
    await page.reload();
    await expect(page.locator('.reward-banner')).toHaveCount(1);
    await page.waitForTimeout(900); // let the drop-in animation settle for the photo
  });
  await page.reload();

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

  // R3a (review #8, C3, D2): the bar title and the compact capture button once a screen scrolls, Capture's
  // Training/Check-in hand-offs, and a stale vault read as a chip in the bar.
  await shot('Log - Progress scrolled (bar title, compact capture)', async () => {
    await goTo(page, 'Progress');
    await page.evaluate(() => window.scrollTo(0, 420));
    await expect(page.locator('header.top')).toHaveAttribute('data-collapsed');
    await expect(page.locator('.fab')).toHaveAttribute('data-compact');
    await page.waitForTimeout(400); // let the pill finish shrinking for the photo
  });
  await shot('Capture - Check-in', async () => {
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await page.getByRole('group', { name: 'Log instead' }).getByRole('button', { name: 'Check-in', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Check-in' })).toBeVisible();
  });
  await page.getByRole('dialog', { name: 'Check-in' }).getByRole('button', { name: 'Close' }).click();
  await shot('Stale vault chip', async () => {
    await goTo(page, 'Tasks');
    await page.clock.fastForward(11 * 60 * 1000);
    await expect(page.getByRole('button', { name: 'Vault stale: open Status' })).toBeVisible();
  });
  // R3b (review #7, #9): the inline check-in's last step, and the Log reopening on the view last shown.
  await shot('Today - check-in sleep step', async () => {
    await goTo(page, 'Today');
    const row = page.getByRole('region', { name: 'Check-in', exact: true });
    await row.getByRole('button', { name: 'Mood +1', exact: true }).click();
    await row.getByRole('button', { name: 'Energy 0', exact: true }).click();
    await expect(row).toContainText('Sleep?');
  });
  await shot('Log - Reading remembered', async () => {
    await goTo(page, 'Log');
    await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Reading', exact: true }).click();
    await goTo(page, 'Today');
    await goTo(page, 'Log');
    await expect(page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Reading', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => window.scrollTo(0, 0));
  });

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
