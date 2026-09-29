import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';

// B2: the Actions list is one line by default (the other specs start it expanded via the config's storage state).
test.use({ storageState: { cookies: [], origins: [] } });

const panel = (page: Page) => page.getByRole('region', { name: 'Actions on this device', exact: true });

async function captureNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  await page.getByLabel('Note text').fill(text);
  await page.getByRole('button', { name: 'Save' }).click();
}

test('collapsed by default, remembered when opened, absent on Scouts, and a problem is never hidden', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await captureNote(page, 'A synthetic garden thought');
  const toggle = panel(page).getByRole('button', { name: 'Actions · 1', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel(page).getByTestId('action')).toHaveCount(0);

  await toggle.click();
  await expect(panel(page).getByTestId('action')).toContainText('A synthetic garden thought');
  await page.reload();
  await expect(panel(page).getByTestId('action')).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'Actions · 1', exact: true }).click();
  await expect(panel(page).getByTestId('action')).toHaveCount(0);

  await page.getByRole('button', { name: /scouts need attention/ }).click();
  await expect(panel(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Today', exact: true }).click();
  api.commandMode = { refuse: { code: 'refused:structure', message: 'Synthetic refusal.', retryable: false } };
  await captureNote(page, 'A refused synthetic thought');
  await expect(panel(page)).toContainText('1 needs attention');
  await expect(panel(page).getByTestId('action')).toHaveCount(0);
  await page.getByRole('button', { name: /scouts need attention/ }).click();
  await expect(panel(page)).toContainText('1 needs attention');
});
