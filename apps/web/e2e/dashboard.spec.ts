import { expect, test, type Locator } from '@playwright/test';
import { HealthResponse } from '@vault-companion/contracts';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

/** UX4: a card that only said "Not configured" is hidden on the Dashboard, so nothing is rendered for it here. */
async function expectUnconfigured(dashboard: Locator) {
  for (const title of ['AI usage'] as const) {
    await expect(dashboard.getByRole('article', { name: title, exact: true })).toHaveCount(0);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Guard against accidentally replacing the API mock with a live public-provider request.
  await page.route('https://api.exchange.coinbase.com/**', (route) => {
    throw new Error(`Unexpected browser provider request: ${new URL(route.request().url()).pathname}`);
  });
});

test('Dashboard keeps Today default and supports mobile ranges, touch and keyboard inspection', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Views' });
  await expect(nav.getByRole('button', { name: 'Today', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(nav.getByRole('button')).toHaveText(['Today', 'Tasks', 'Scouts', 'Notes', 'Log']);
  await goTo(page, 'Today');
  const dashboard = page.getByRole('region', { name: 'Dashboard', exact: true });
  const market = dashboard.getByRole('article', { name: 'BTC / USD', exact: true });
  await expect(market.locator('.dash-price')).toHaveText('$60,123.45');
  await expect(market.locator('.dash-chip')).toHaveText('Live');
  await expect(market).toContainText('Coinbase Exchange (public)');
  await expect(market.locator('.dash-times')).toContainText(/Market time .*11:59 UTC/);
  await expect(market.locator('.dash-times')).toContainText(/fetched .*12:00 UTC/);
  await expect(market.locator('.dash-times time').first()).toHaveAttribute('datetime', '2026-09-30T11:59:00Z');
  await expect(market.locator('.dash-times time').last()).toHaveAttribute('datetime', api.dashboardFetchedAt);
  await expectUnconfigured(dashboard);
  await expect(dashboard.getByRole('article', { name: 'Health', exact: true })).toHaveCount(0);

  for (const [range, label, count] of [['1W', '1 week', 167], ['1M', '1 month', 119], ['3M', '3 months', 89]] as const) {
    await dashboard.getByRole('button', { name: range, exact: true }).click();
    await expect(dashboard.getByRole('button', { name: range, exact: true })).toHaveAttribute('aria-pressed', 'true');
    const chart = market.getByRole('img', { name: `BTC / USD ${label}: ${count} points, 1 intervals missing`, exact: true });
    await expect(chart).toBeVisible();
    await expect(market).toContainText('1 intervals missing — shown as gaps, not filled in.');
    await expect(chart.locator('polyline')).toHaveCount(2);
    await chart.scrollIntoViewIfNeeded();
    const box = await chart.boundingBox();
    if (!box) throw new Error('Chart has no touch target');
    await page.touchscreen.tap(box.x + 1, box.y + box.height / 2);
    await expect(market.locator('figcaption')).toContainText('$60,000.00');
    const slider = market.getByRole('slider', { name: `Inspect ${label}`, exact: true });
    await expect(slider).toHaveValue('0');
    await slider.focus();
    await slider.press('ArrowRight');
    await expect(slider).toHaveValue('1');
    await expect(market.locator('figcaption')).toContainText('$60,001.00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(api.dashboardRanges).toContain(range);
  }
  await goTo(page, 'Tasks');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(dashboard).toHaveCount(0);
});

test('Health board shows four formatted tiles with gap-aware sparklines', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Health', exact: true }).click();
  const health = page.getByRole('article', { name: 'Health', exact: true });
  await expect(health).toContainText('Data from 29 Sept 2026');
  await expect(health.locator('.health-tile')).toHaveCount(4);
  await expect(health.locator('.health-tile').nth(0)).toContainText('12,345');
  await expect(health.locator('.health-tile').nth(0)).toContainText('Above usual');
  await expect(health.locator('.health-tile').nth(1)).toContainText('46');
  await expect(health.locator('.health-tile').nth(2)).toContainText('00:30');
  await expect(health.locator('.health-tile').nth(3)).toContainText('18:00');
  await expect(health.locator('svg.health-spark')).toHaveCount(4);
  await expect(health.locator('svg.health-spark').first()).toHaveAttribute('aria-hidden', 'true');
  expect(api.healthReads).toBe(1);
});

test('Health board labels old data and uses the stale styling at three days', async ({ page }) => {
  const api = new MockApi();
  api.health = HealthResponse.parse({ ...api.health, day: '2026-09-26', staleDays: 3 });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Health', exact: true }).click();
  const health = page.getByRole('article', { name: 'Health', exact: true });
  await expect(health).toContainText('Data from 26 Sept 2026 — 3 days old');
  await expect(health.locator('.dash-stale')).toHaveCount(1);
});

test('Health board reports a missing export without tiles or sparklines', async ({ page }) => {
  const api = new MockApi();
  api.health = HealthResponse.parse({ revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'missing', metrics: [] });
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Log');
  await page.getByRole('group', { name: 'Log view' }).getByRole('button', { name: 'Health', exact: true }).click();
  const health = page.getByRole('article', { name: 'Health', exact: true });
  await expect(health).toContainText('No Apple Health export in the vault yet.');
  await expect(health.locator('.health-tile, svg')).toHaveCount(0);
});

test('stale market times stay honest and ticker-only polling preserves history on failure', async ({ page }) => {
  await page.clock.install();
  const api = new MockApi();
  api.dashboardFetchedAt = '2026-09-30T11:55:00Z';
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const dashboard = page.getByRole('region', { name: 'Dashboard', exact: true });
  const market = dashboard.getByRole('article', { name: 'BTC / USD' });
  await expect(market.locator('.dash-chip')).toHaveText('Stale');
  await expect(market).toContainText('This value is not fresh');
  await expect(market.locator('.dash-times time').last()).toHaveAttribute('datetime', api.dashboardFetchedAt);
  const historyReads = api.dashboardRanges.length;
  await page.clock.fastForward(60_000);
  await expect(market.locator('.dash-price')).toHaveText('$60,234.56');
  await expect(market.locator('.dash-chip')).toHaveText('Live');
  await expect(market.locator('.dash-times time').first()).toHaveAttribute('datetime', '2026-09-30T12:00:30Z');
  await expect(market.locator('.dash-times time').last()).toHaveAttribute('datetime', '2026-09-30T12:01:00Z');
  expect(api.tickerReads).toBe(1);
  expect(api.dashboardRanges).toHaveLength(historyReads);
  api.marketTicker = { status: 'unavailable', now: '2026-09-30T12:02:00Z', reason: 'provider-error' };
  await page.clock.fastForward(60_000);
  await expect(market.locator('.dash-chip')).toHaveText('Stale');
  await expect(dashboard).toContainText('Not refreshed — the times below are from the last success.');
  await expect(market.locator('.dash-price')).toHaveText('$60,234.56');
  await expect(market.locator('.dash-times time').last()).toHaveAttribute('datetime', '2026-09-30T12:01:00Z');
  await expect(market.getByRole('img')).toBeVisible();
  expect(api.dashboardRanges).toHaveLength(historyReads);
  await expectUnconfigured(dashboard);
});

test('partial history failure and unavailable market leave honest overview cards and Today usable', async ({ page }) => {
  const api = new MockApi();
  api.dashboardMode = 'no-history';
  await api.install(page);
  await page.goto('/');
  await goTo(page, 'Today');
  const dashboard = page.getByRole('region', { name: 'Dashboard', exact: true });
  const market = dashboard.getByRole('article', { name: 'BTC / USD' });
  await expect(market.locator('.dash-price')).toHaveText('$60,123.45');
  await expect(market).toContainText('History is unavailable.');
  await expect(market.getByRole('img')).toHaveCount(0);
  await expect(market.getByRole('slider')).toHaveCount(0);
  await expectUnconfigured(dashboard);
  api.dashboardMode = 'unavailable';
  await dashboard.getByRole('button', { name: '1M', exact: true }).click();
  await expect(market.locator('.dash-chip')).toHaveText('Unavailable');
  await expect(market).toContainText('Market data is unavailable.');
  await expect(market.locator('.dash-price, time, svg')).toHaveCount(0);
  await expectUnconfigured(dashboard);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await goTo(page, 'Today');
  await expect(page.getByRole('region', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('SP3c (ADR-0038): a range seen before reopens from its labelled copy when the read fails', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  // Copies are kept per account: open the Dashboard once the session has named it.
  const session = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session' && r.ok());
  await page.goto('/');
  await session;
  await goTo(page, 'Today');
  const dashboard = page.getByRole('region', { name: 'Dashboard', exact: true });
  const market = dashboard.getByRole('article', { name: 'BTC / USD', exact: true });
  // The Health panel keeps its own copy note; this test is about the Dashboard's.
  const dashNote = dashboard.locator(':scope > [data-testid="copy-note"]');
  await expect(market.locator('.dash-price')).toHaveText('$60,123.45');
  await expect(dashNote).toHaveCount(0);

  await goTo(page, 'Tasks');
  api.network = 'down';
  await goTo(page, 'Today');
  await expect(dashNote).toHaveText(/^Could not refresh · showing the copy from \d\d:\d\d$/);
  await expect(market.locator('.dash-price')).toHaveText('$60,123.45');
  await expect(market.locator('.dash-chip')).toHaveText('Stale');
  await expect(market.locator('svg.dash-svg')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('sp3c-dashboard-copy-390x844.png') });
  // A range never seen has no copy: the failure is said plainly, the 1W copy stays labelled as stale.
  await dashboard.getByRole('button', { name: '1M', exact: true }).click();
  await expect(dashNote).toHaveCount(0);
  await expect(market.locator('.dash-chip')).toHaveText('Stale');
});
