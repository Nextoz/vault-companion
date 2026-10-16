import { MorningBriefResponse } from '@vault-companion/contracts';
import { expect, test } from '@playwright/test';
import { ACCOUNT, MockApi } from './mock-api.ts';
import { seenKey } from '../src/achievements.ts';

const TODAY = '2026-10-15';
const headlines = [
  'Synthetic story: How a small engineering team made its database upgrades easier to understand and safer to operate',
  'Synthetic story: A new open source tool for exploring the night sky',
  'Synthetic story: What we learned restoring a forty year old computer',
] as const;
const items = headlines.map((title, index) => ({ title, line: '240 points; 85 comments on Hacker News', url: `https://news.ycombinator.com/item?id=${123 + index}` }));

for (const state of ['ready', 'empty', 'unavailable', 'legacy'] as const) {
  test(`Today Hacker News: ${state}`, async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date(`${TODAY}T08:00:00Z`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(['a1', 'a2', 'a3'])), seenKey(ACCOUNT));
    const api = new MockApi();
    api.morning = MockApi.SAMPLE_MORNING;
    api.morningBrief = MorningBriefResponse.parse({
      revision: 'a'.repeat(40), date: TODAY, generatedAt: `${TODAY}T06:00:00Z`, source: 'fallback', unavailable: [],
      brief: { source: 'fallback', dayLine: 'A quiet synthetic day.', gaps: [], todos: [],
        ...(state === 'legacy' ? {} : { hackerNews: state === 'ready' ? items : [], hackerNewsUnavailable: state === 'unavailable' }),
      },
    });
    await api.install(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Morning Brief', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Morning Brief' });
    const heading = sheet.getByText('Hacker News', { exact: true });
    if (state === 'legacy') {
      await expect(heading).toHaveCount(0);
      return;
    }
    await expect(heading).toBeVisible();
    if (state === 'ready') {
      await expect(sheet.locator('li').filter({ hasText: headlines[0] })).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath('hn-collapsed.png') });
    }
    await heading.click();
    if (state === 'ready') {
      const links = sheet.getByRole('link', { name: 'Open link', exact: true });
      await expect(links).toHaveCount(3);
      for (let index = 0; index < items.length; index++) {
        await expect(links.nth(index)).toHaveAttribute('href', items[index]!.url);
        expect((await links.nth(index).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
      await expect(sheet.locator('li').filter({ hasText: headlines[0] })).toBeVisible();
      expect(await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('hn-open.png') });
      await links.last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('hn-scrolled.png') });
    } else {
      await expect(sheet.getByText(state === 'empty' ? 'Nothing new here today.' : 'Source unavailable.', { exact: true })).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Open link', exact: true })).toHaveCount(0);
    }
  });
}
