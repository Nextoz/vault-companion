import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';

test('Today indicator → real stack and details → go → Calendar pending → undo', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-27T12:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const api = new MockApi();
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-25T06:50:00+02:00', appliedUpdatedAt: '2026-09-27T08:00:00Z', cards: [
    { eventId: '0a1b2c3d4e5f60718293', rank: 1, explore: false, resurfaced: false, title: 'Evening talk on city gardens',
      start: '2026-09-29T17:00:00+02:00', end: null, location: 'Community hall', online: false, cost: 'Free',
      registration: { state: 'open', deadline: '2026-09-28T23:59:00+02:00' }, aiScore: 88, why: 'Hands-on and close by.',
      category: 'community', scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1',
      calendar: { inCalendar: 'auto', clash: { title: 'Gym class', start: '2026-09-29T17:30:00+02:00', end: '2026-09-29T18:30:00+02:00' }, freeThatEvening: false } },
  ] };
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: '1 new events' }).click();
  const dialog = page.getByRole('dialog', { name: 'Event triage stack' });
  await expect(dialog.getByText('Event feed from 2026-09-25T06:50:00+02:00')).toBeVisible();
  await dialog.getByRole('article', { name: /Evening talk/ }).tap();
  await expect(dialog.getByRole('link', { name: 'Source: Example source' })).toHaveAttribute('href', 'https://example.org/e1');
  await dialog.getByRole('button', { name: 'Back to events' }).click();
  api.commandMode = 'hold';
  await dialog.getByRole('button', { name: 'Go: add to Calendar' }).click();
  await expect(dialog.getByText(/· go · Calendar: pending/)).toBeVisible();
  await expect(dialog.getByText('Waiting for your PC to apply Calendar changes')).toBeVisible();
  await expect(dialog.getByText('All caught up. Next scouts: tomorrow 06:50')).toBeVisible();
  await expect.poll(() => api.heldCount).toBe(1);
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog.getByRole('article', { name: /Evening talk/ })).toBeVisible();
  api.release();
  await expect.poll(() => api.applied.map((c) => c.type === 'TriageDecide' ? c.payload.decision : c.type)).toEqual(['go', 'undo']);
  const go = api.applied[0]!;
  const undo = api.applied[1]!;
  expect(undo).toMatchObject({ type: 'TriageDecide', payload: { undoes: go.operationId, decision: 'undo', card: {
    title: 'Evening talk on city gardens', category: 'community', sourceName: 'Example source', aiScore: 88, start: '2026-09-29T17:00:00+02:00',
  } } });
  expect(undo.operationId).not.toBe(go.operationId);
});
