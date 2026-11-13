import { expect, test } from '@playwright/test';
import { MockApi, taskView } from './mock-api.ts';
import { goTo } from './nav.ts';

// B14 (owner, 2026-10-21): ticking a task off far down a long list sent the page back to the top, because the list
// was replaced by "Refreshing…" for a moment while the saved completion was acknowledged.
for (const screen of ['All', 'Tasks'] as const) {
  test(`B14: completing a task far down ${screen} keeps the list and the scroll position`, async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-24T10:00:00Z') });
    const api = new MockApi();
    api.open = Array.from({ length: 40 }, (_, i) => taskView(10 + i, `Synthetic task ${String(i + 1).padStart(2, '0')}`));
    await api.install(page);
    await page.goto('/');
    await goTo(page, screen);

    const target = page.getByRole('button', { name: 'Complete: Synthetic task 30' });
    await target.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 120));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(400);
    // Every frame from here on: the smallest number of task rows on screen and the lowest scroll position reached.
    await page.evaluate(() => {
      const seen = { rows: Infinity, y: Infinity };
      (window as unknown as { b14: typeof seen }).b14 = seen;
      const tick = () => {
        seen.rows = Math.min(seen.rows, document.querySelectorAll('[data-testid=task]').length);
        seen.y = Math.min(seen.y, window.scrollY);
        requestAnimationFrame(tick);
      };
      tick();
    });

    await target.click();
    await expect.poll(() => api.applied.length).toBe(1);
    await page.clock.runFor(4000);
    // Gone from the open rows; on Tasks it now sits in Done today.
    await expect(page.getByTestId('task').filter({ hasText: 'Synthetic task 30' })).toHaveCount(screen === 'All' ? 0 : 1);

    const seen = await page.evaluate(() => (window as unknown as { b14: { rows: number; y: number } }).b14);
    expect(seen.rows).toBeGreaterThanOrEqual(39);
    expect(before - seen.y).toBeLessThan(80); // the folded row's own height at most
    // The next task is still under the thumb, so several can be ticked in a row.
    await expect(page.getByRole('button', { name: 'Complete: Synthetic task 31' })).toBeInViewport();
  });
}
