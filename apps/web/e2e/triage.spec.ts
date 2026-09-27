import { expect, test } from '@playwright/test';
for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`Date-first drag, skip reason and undo (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto('http://localhost:5174/e2e/fixtures/triage.html');
    const first = page.getByRole('article', { name: /Invented tool meetup/ });
    await expect(first).toBeVisible();
    const box = (await first.boundingBox())!;
    await page.mouse.move(box.x + 80, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 220, box.y + 160, { steps: 8 });
    await expect(first.locator('.triage-stamp.triage-go')).toHaveCSS('opacity', '1');
    if (reducedMotion === 'reduce') {
      await expect(first).toHaveCSS('transition-duration', '0s');
      const rotation = await first.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).b);
      expect(rotation).toBe(0);
    }
    await page.mouse.up();
    await expect(page.getByTestId('calls')).toHaveText('example-0:go:');
    await expect(page.getByRole('article', { name: /Invented writing workshop/ })).toBeVisible();
    await page.getByRole('button', { name: 'Skip this event' }).click();
    await expect(page.getByRole('group', { name: 'Skip reason' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Busy', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('article', { name: /Invented harbour film/ })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Skip reason' })).toBeHidden({ timeout: 3500 });
    await expect(page.getByTestId('calls')).toHaveText('example-0:go:|example-1:skip:busy');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('article', { name: /Invented writing workshop/ })).toBeVisible();
    await expect(page.getByTestId('calls')).toHaveText('example-0:go:|example-1:skip:busy|undo');
    await page.getByRole('button', { name: 'Skip this event' }).click();
    await page.getByRole('button', { name: 'Too far', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Too far', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Skip reason' })).toBeHidden({ timeout: 3500 });
    await expect(page.getByTestId('calls')).toHaveText('example-0:go:|example-1:skip:busy|undo|example-1:skip:too-far');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('calls')).toHaveText('example-0:go:|example-1:skip:busy|undo|example-1:skip:too-far|undo');
    await page.getByRole('button', { name: 'Ask me later' }).click();
    await expect(page.getByTestId('calls')).toContainText('example-1:maybe:');
  });
}

