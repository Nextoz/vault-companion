import { expect, test, type Page } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { waitForSettledRetry } from './settled-retry.ts';

const actions = (page: Page) => page.getByRole('region', { name: 'Actions on this device', exact: true });

async function openReport(page: Page) {
  await page.getByRole('button', { name: 'Report a bug or wish', exact: true }).click();
  return page.getByRole('dialog', { name: 'Report', exact: true });
}

test('offline report queues, sends once back online, and its Undo targets the durable receipt', async ({ page, context }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Today', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');

  const sheet = await openReport(page);
  await expect(sheet.getByRole('button', { name: 'Bug', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Wish', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Wish', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByLabel('What happened?').fill('A synthetic wish');
  await expect(sheet.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();

  api.commandMode = 'offline';
  await context.setOffline(true);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toHaveCount(0);

  const row = actions(page).getByTestId('action').filter({ hasText: 'Report' });
  await expect(row).toContainText('On this device');
  expect(api.applied).toHaveLength(0);
  // The initial pending render precedes the send; let that attempt settle before reconnecting (see settled-retry.ts).
  await waitForSettledRetry(page);

  api.commandMode = 'ok';
  await context.setOffline(false);
  await expect(row).toContainText('Saved to GitHub');
  expect(api.applied.map((c) => c.type)).toEqual(['ReportFeedback']);
  const report = api.applied[0];
  expect(report?.type === 'ReportFeedback' && report.payload).toMatchObject({ kind: 'wish', screen: 'Today', text: 'A synthetic wish' });
  expect(new Set(api.bodies).size).toBe(1);

  await row.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => api.applied.map((c) => c.type)).toEqual(['ReportFeedback', 'UndoReportFeedback']);
  const undo = api.applied[1];
  expect(undo?.type).toBe('UndoReportFeedback');
  if (undo?.type === 'UndoReportFeedback' && report?.type === 'ReportFeedback') {
    // The Undo names the durable envelope, never the UI bytes, and carries the receipt's commit token.
    expect(undo.payload.target.operationId).toBe(report.operationId);
    expect(undo.payload.targetCommit).toMatch(/^[0-9a-f]{40}$/);
  }
  await expect(actions(page).getByTestId('action').filter({ hasText: 'Undo report' })).toBeVisible();
});

test('an Undo refused with conflict:report-changed shows a refusal without crashing', async ({ page }) => {
  const api = new MockApi();
  await api.install(page);
  await page.goto('/');
  const sheet = await openReport(page);
  await sheet.getByLabel('What happened?').fill('A synthetic bug');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();

  const row = actions(page).getByTestId('action').filter({ hasText: 'Report' });
  await expect(row).toContainText('Saved to GitHub');

  api.commandMode = { refuse: { code: 'conflict:report-changed', message: 'This report changed on another device.', retryable: false } };
  await row.getByRole('button', { name: 'Undo', exact: true }).click();

  const undoRow = actions(page).getByTestId('action').filter({ hasText: 'Undo report' });
  await expect(undoRow).toContainText('Needs attention');
  await expect(undoRow).toContainText('This report changed on another device.');
  await expect(page.getByRole('button', { name: 'Report a bug or wish', exact: true })).toBeVisible();
});
