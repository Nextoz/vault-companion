// Guards the user-visible defects from the October UI review, with realistic-length synthetic content.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { TriageResponse } from '@vault-companion/contracts';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

const LONG_TITLE = 'Prepare the quarterly project update and review the outstanding actions before the team meeting';
const CLOCK = new Date('2026-09-24T06:00:00Z');

async function openToday(page: Page, kind: 'task' | 'event' | 'empty', title = LONG_TITLE) {
  await page.clock.install({ time: CLOCK });
  const api = new MockApi();
  api.gameMode = 'error'; // Keep reward overlays out of the geometry and screenshots.
  if (kind === 'task') api.open = [taskView(10, title), taskView(11, 'Call the bike shop')];
  if (kind === 'event') api.triage = TriageResponse.parse({ ...api.triage, now: CLOCK.toISOString(), feedState: 'ok', generatedAt: CLOCK.toISOString(),
    cards: [{ eventId: '1'.repeat(20), rank: 1, explore: false, resurfaced: false, summary: '', title,
      start: '2026-09-24T09:00:00+02:00', end: null, location: 'Synthetic hall', online: false, cost: 'Free',
      registration: { state: 'not-required', deadline: null }, aiScore: 80, why: 'Synthetic reason.',
      category: 'community', scouts: ['city-events'], sourceName: 'Synthetic source', sourceUrl: 'https://example.org/event',
      calendar: { inCalendar: 'own', clash: null, freeThatEvening: true } }],
  });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const card = page.getByRole('region', { name: 'Next up', exact: true });
  await expect(card).toContainText(kind === 'empty' ? 'Nothing planned' : title);
  return card;
}

async function readableWithin(element: Locator) {
  const size = await element.evaluate((e) => ({ width: e.clientWidth, fullWidth: e.scrollWidth, height: e.clientHeight, fullHeight: e.scrollHeight }));
  expect(size.fullWidth).toBeLessThanOrEqual(size.width + 1);
  expect(size.fullHeight).toBeLessThanOrEqual(size.height + 1);
}

async function tapTarget(element: Locator) {
  const box = await element.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

for (const width of [320, 390, 430]) {
  for (const kind of ['task', 'event'] as const) {
    test(`Next up long ${kind} is readable content at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const card = await openToday(page, kind);
      const title = card.locator('.next-up-title');
      const type = await title.evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize),
        body: parseFloat(getComputedStyle(document.body).fontSize), weight: getComputedStyle(e).fontWeight,
        pageTitle: parseFloat(getComputedStyle(document.querySelector('h1')!).fontSize) }));
      expect(type.size).toBeLessThanOrEqual(type.body * 1.1);
      expect(type.size).toBeLessThan(type.pageTitle);
      expect(type.weight).toBe('600');
      await readableWithin(title);
      await tapTarget(card.getByRole('button', { name: 'Start', exact: true }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) await page.screenshot({ path: test.info().outputPath(`next-up-long-${kind}.png`), animations: 'disabled' });
    });
  }
}

for (const kind of ['task', 'event', 'empty'] as const) {
  test(`Next up ${kind} keeps its short or empty state`, async ({ page }) => {
    const card = await openToday(page, kind, 'Water the plants');
    await expect(card.getByRole('button', { name: kind === 'empty' ? 'Add a task' : 'Start', exact: true })).toBeVisible();
    await readableWithin(card);
  });
}

test('Next up respects enlarged text without truncation or overlapping actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const card = await openToday(page, 'task');
  const before = await card.locator('.next-up-title').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  await page.evaluate(() => document.documentElement.style.setProperty('font-size', '34px'));
  const after = await card.locator('.next-up-title').evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(after).toBeGreaterThanOrEqual(before * 1.8);
  await readableWithin(card.locator('.next-up-title'));
  const start = card.getByRole('button', { name: 'Start', exact: true });
  await start.scrollIntoViewIfNeeded();
  await tapTarget(start);
  const a = await start.boundingBox();
  const b = await card.locator('.next-up-more').boundingBox();
  expect(a!.x + a!.width <= b!.x + 1 || a!.y + a!.height <= b!.y + 1).toBe(true);
  await readableWithin(card);
});

test('Needs you separates title, explanation and dismiss action', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openToday(page, 'task');
  await page.getByRole('button', { name: /^Needs you/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Needs you' });
  await expect(sheet.locator('.needs-you-list')).toHaveCSS('list-style-type', 'none');
  const row = sheet.getByRole('button', { name: /City events/ });
  await expect(row).toContainText('runner could not start');
  // Read both boxes in one frame: the sheet's entrance animation moves between separate protocol calls.
  const layout = await row.evaluate((element) => {
    const title = element.querySelector('.needs-you-title')!.getBoundingClientRect();
    const reason = element.querySelector('.muted')!.getBoundingClientRect();
    return { titleBottom: title.bottom, reasonTop: reason.top };
  });
  expect(layout.reasonTop).toBeGreaterThanOrEqual(layout.titleBottom);
  await tapTarget(sheet.getByRole('button', { name: 'Got it' }));
  await readableWithin(row);
  await page.screenshot({ path: test.info().outputPath('needs-you.png'), animations: 'disabled' });
});

test('Calendar title matches the app fields and task calendar actions are touch-sized', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openToday(page, 'task');
  await goTo(page, 'Tasks');
  const glyph = page.getByRole('button', { name: 'Add to Calendar: Call the bike shop', exact: true });
  await tapTarget(glyph);
  await glyph.click();
  const sheet = page.getByRole('dialog', { name: 'Add to Calendar' });
  const field = sheet.getByLabel('Title', { exact: true });
  await expect(field).toHaveValue('Call the bike shop');
  const font = await field.evaluate((e) => ({ family: getComputedStyle(e).fontFamily, size: parseFloat(getComputedStyle(e).fontSize) }));
  const notes = await sheet.getByRole('textbox', { name: 'Notes', exact: true }).evaluate((e) => ({ family: getComputedStyle(e).fontFamily, size: parseFloat(getComputedStyle(e).fontSize) }));
  expect(font).toEqual(notes);
  expect(font.size).toBeGreaterThanOrEqual(16);
  await readableWithin(field);
  await page.screenshot({ path: test.info().outputPath('calendar-fields.png'), animations: 'disabled' });
});

test('AI usage gives values with units and keeps range labels on one line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openToday(page, 'empty');
  await goTo(page, 'Board');
  const panel = page.getByRole('region', { name: 'AI usage', exact: true });
  await panel.scrollIntoViewIfNeeded();
  // The range toggle only exists once the collapsed panel is expanded from its header.
  await panel.getByRole('button', { name: 'AI usage', exact: true }).click();
  for (const name of ['7 d', '30 d']) {
    const button = panel.getByRole('button', { name, exact: true });
    await expect(button).toHaveCSS('white-space', 'nowrap');
    await readableWithin(button);
    await tapTarget(button);
  }
  await expect(panel.locator('.ai-usage-value')).toHaveCount(5);
  await expect(panel.locator('.ai-usage-tile', { hasText: 'Codex' }).locator('.ai-usage-value')).toContainText('tokens');
  await expect(panel.locator('.ai-usage-tile', { hasText: 'Jev' }).locator('.ai-usage-value')).toContainText('calls');
  await expect(panel.locator('.ai-usage-tile', { hasText: 'DeepSeek' }).locator('.ai-usage-value')).toContainText('$');
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('ai-usage.png'), animations: 'disabled' });
});
