import { expect, test, type Page } from '@playwright/test';
import type { TriageResponse } from '@vault-companion/contracts';
import { MockApi } from './mock-api.ts';

// The mock's history "today" is Thu 24 Sep 2026, so this week is Mon 21 – Sun 27 Sep (Europe/Copenhagen).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const decision = (n: number, extra: Partial<TriageResponse['decisions'][number]>): TriageResponse['decisions'][number] => ({
  decisionId: id(n), eventId: n.toString(16).padStart(20, '0'), decision: 'go', outcome: null, undoes: null,
  at: '2026-09-20T10:00:00Z', title: `Synthetic event ${n}`, start: '2026-09-26T18:00:00+02:00', ...extra });

function seeded(): MockApi {
  const api = new MockApi();
  const task = (lineIndex: number, description: string, doneDate: string) => ({ source: 'todo' as const, description, doneDate, links: [],
    locator: { path: 'Tasks/To-Do List.md' as const, blobSha: '2'.repeat(40), lineIndex, lineText: `- [x] ${description} ✅ ${doneDate}`, occurrencesAtRead: 1 } });
  api.olderHistory.push(task(20, 'Repot the fern', '2026-09-24'), task(21, 'Sort the seed tins', '2026-09-22'));
  const row = (date: string, type: string, distance: string, split = '') => ({ date, time: '07:00', type, distance, duration: '30', weight: '', split, note: '' });
  api.trainingRows = [row('2026-09-24', 'Run', '4'), row('2026-09-23', 'Gym', '', 'Push'), row('2026-09-22', 'Run', '5.2 km'), row('2026-09-15', 'Run', '6')];
  api.triage.decisions = [
    decision(1, {}),
    decision(2, { decision: 'attended', outcome: 'worth', start: '2026-09-21T18:00:00+02:00', at: '2026-09-22T08:00:00Z' }),
    decision(3, {}),
    decision(4, { eventId: (3).toString(16).padStart(20, '0'), decision: 'undo', undoes: id(3), at: '2026-09-20T10:05:00Z' }),
  ];
  return api;
}

async function openProgress(page: Page, api: MockApi) {
  await page.setViewportSize({ width: 390, height: 844 });
  await api.install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Progress' }).click();
  return page.getByRole('region', { name: 'Progress', exact: true });
}

test('Progress: this week’s counts with evidence on tap, earlier weeks expand, the day list stays', async ({ page }) => {
  const progress = await openProgress(page, seeded());
  const week = progress.getByRole('region', { name: 'This week' });
  await expect(week.getByTestId('week-summary')).toHaveText('2 tasks · 1 Active Work · 2 runs (9.2 km) · 1 gym · 2 events (1 attended) · 1 note');
  await expect(week).toContainText('21–27 Sep');
  await expect(week).not.toContainText('unavailable');

  const toggle = week.getByRole('button', { name: 'Show what happened' });
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.click();
  await expect(week.getByRole('region', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(2);
  await expect(week.getByRole('region', { name: 'Active Work' })).toContainText('Garden plan: beds ready Garden Plan');
  await expect(week.getByRole('region', { name: 'Runs' }).getByRole('listitem')).toHaveText([/Thu 24 Sep · 4 km/, /Tue 22 Sep · 5.2 km/]);
  await expect(week.getByRole('region', { name: 'Gym' })).toContainText('Push');
  const events = week.getByRole('region', { name: 'Events' });
  await expect(events.getByRole('listitem')).toHaveText([/Synthetic event 2.*Attended, worth it/, /Synthetic event 1.*Go/]);
  await expect(events).not.toContainText('Synthetic event 3'); // undone
  await week.getByRole('button', { name: 'Seed order' }).click();
  await expect(page.getByText('Tomatoes and')).toBeVisible();
  await page.getByRole('button', { name: /Back/ }).click();

  const earlier = page.getByRole('region', { name: 'Earlier weeks' });
  const rows = earlier.getByRole('button');
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toHaveText('14–20 Sep: 1 run (6 km)');
  await expect(rows.nth(1)).toHaveText('7–13 Sep: Nothing recorded');
  expect((await rows.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await rows.first().click();
  await expect(rows.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(earlier.getByRole('region', { name: 'Runs' })).toContainText('Tue 15 Sep · 6 km');

  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(history.getByRole('heading', { level: 2 })).toHaveText(['Thu 24 Sep', 'Wed 23 Sep', 'Tue 22 Sep']);
  await expect(page.getByText(/streak|target|best week/i)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Progress: a failed training read says "Training unavailable" and the rest still renders', async ({ page }) => {
  const api = seeded();
  api.trainingMode = 'error';
  const progress = await openProgress(page, api);
  const week = progress.getByRole('region', { name: 'This week' });
  await expect(week.getByTestId('week-summary')).toHaveText('2 tasks · 1 Active Work · 2 events (1 attended) · 1 note · Training unavailable');
  // An earlier week with a failed source is never presented as empty.
  await expect(page.getByRole('region', { name: 'Earlier weeks' }).getByRole('button').first()).toHaveText('14–20 Sep: Training unavailable');
  await expect(page.getByRole('region', { name: 'History', exact: true }).getByRole('heading', { level: 2 })).toHaveCount(3);
});

test('Progress: a training read that never answers does not hold back the other sources', async ({ page }) => {
  const api = seeded();
  api.trainingMode = 'hang';
  const progress = await openProgress(page, api);
  const week = progress.getByRole('region', { name: 'This week' });
  await expect(week.getByTestId('week-summary')).toHaveText('2 tasks · 1 Active Work · 2 events (1 attended) · 1 note · Training loading…');
});

test('SP3 (ADR-0038): Progress seen before reopens from its labelled copy when the reads fail', async ({ page }) => {
  const api = seeded();
  await openProgress(page, api);
  const progress = page.getByRole('region', { name: 'Progress', exact: true });
  await expect(progress.getByTestId('week-summary')).toBeVisible();
  await expect(progress.getByTestId('copy-note')).toHaveCount(0);
  const days = await progress.getByTestId('history-item').count();
  expect(days).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Training', exact: true }).click();
  api.network = 'down';
  await page.getByRole('button', { name: 'Progress', exact: true }).click();
  await expect(progress.getByTestId('copy-note')).toHaveText(/^Could not refresh · showing the copy from \d\d:\d\d$/);
  await expect(progress.getByTestId('week-summary')).toBeVisible();
  await expect(progress.getByTestId('history-item')).toHaveCount(days);
  await expect(progress.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('sp3b-progress-copy-390x844.png') });
});
