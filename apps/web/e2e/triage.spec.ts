import { expect, test } from '@playwright/test';
import { MockApi } from './mock-api.ts';
import { goTo } from './nav.ts';

test('Today indicator → real stack and details → go → Calendar pending → undo', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-27T12:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const api = new MockApi();
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-25T06:50:00+02:00', appliedUpdatedAt: '2026-09-27T08:00:00Z', cards: [
    { eventId: '0a1b2c3d4e5f60718293', rank: 1, explore: false, resurfaced: false, summary: '', title: 'Evening talk on city gardens',
      start: '2026-09-29T17:00:00+02:00', end: null, location: 'Community hall', online: false, cost: 'Free',
      registration: { state: 'open', deadline: '2026-09-28T23:59:00+02:00' }, aiScore: 88, why: 'Hands-on and close by.',
      category: 'community', scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1',
      calendar: { inCalendar: 'auto', clash: { title: 'Gym class', start: '2026-09-29T17:30:00+02:00', end: '2026-09-29T18:30:00+02:00', kind: 'own' }, freeThatEvening: false } },
  ] };
  await api.install(page);
  await page.goto('/');
  // UX8: event triage lives on the Scouts tab (the old Today events line is gone; Needs you still surfaces pending decisions).
  await goTo(page, 'Scouts');
  await page.getByRole('button', { name: '1 new event' }).click();
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

test('a decision made while the previous one is still saving is kept, and Undo targets the latest card (CodeRabbit #35)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-27T12:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const api = new MockApi();
  const card = (eventId: string, title: string, rank: number) => ({ eventId, rank, explore: false, resurfaced: false, summary: '', title,
    start: '2026-09-30T17:00:00+02:00', end: null, location: 'Hall', online: false, cost: 'Free',
    registration: { state: 'unknown' as const, deadline: null }, aiScore: 80, why: 'Close by.', category: 'community',
    scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/' + eventId,
    calendar: { inCalendar: null, clash: null, freeThatEvening: true } });
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-27T06:50:00+02:00', appliedUpdatedAt: '2026-09-27T11:00:00Z',
    cards: [card('aaaaaaaaaaaaaaaaaaaa', 'First event A', 1), card('bbbbbbbbbbbbbbbbbbbb', 'Second event B', 2)] };
  api.commandMode = 'hold';
  await api.install(page);
  await page.goto('/');
  // UX8: event triage lives on the Scouts tab (see the first test).
  await goTo(page, 'Scouts');
  await page.getByRole('button', { name: '2 new events' }).click();
  const dialog = page.getByRole('dialog', { name: 'Event triage stack' });
  await dialog.getByRole('button', { name: /^Skip/ }).click();
  await dialog.getByRole('button', { name: 'Go: add to Calendar' }).click();
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  api.release();
  await expect.poll(() => api.applied.map((c) => c.type === 'TriageDecide' ? `${c.payload.decision}:${c.payload.eventId[0]}` : c.type))
    .toEqual(['skip:a', 'go:b', 'undo:b']);
  const goB = api.applied[1]!;
  expect(api.applied[2]).toMatchObject({ payload: { decision: 'undo', undoes: goB.operationId } });
});

test('check-ins are extra, attended undo works, summaries and both Go overlap sources render, and skip reasons stay', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-27T12:00:00Z') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const api = new MockApi();
  const makeCard = (rank: number, title: string, start: string, end: string) => ({ eventId: rank.toString(16).padStart(20, '0'), rank,
    explore: false, resurfaced: false, summary: `Summary ${rank} appears before the facts.`, title, start, end, location: 'Synthetic hall', online: false,
    cost: 'Free', registration: { state: 'not-required' as const, deadline: null }, aiScore: 80, why: `Why ${rank} appears last.`,
    category: 'synthetic', scouts: ['synthetic-scout'], sourceName: 'Synthetic source', sourceUrl: `https://example.org/${rank}`,
    calendar: { inCalendar: null, clash: null as null | { title: string; start: string; end: string; kind: 'go' | 'own' }, freeThatEvening: true } });
  const cards = Array.from({ length: 10 }, (_, i) => makeCard(i + 1, `Synthetic event ${i + 1}`, `2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')}T${String(14 + i % 3).padStart(2, '0')}:00:00+02:00`, `2026-10-${String(1 + Math.floor(i / 3)).padStart(2, '0')}T${String(15 + i % 3).padStart(2, '0')}:00:00+02:00`));
  cards[0]!.calendar.clash = { title: 'Synthetic saved Go', start: cards[0]!.start, end: cards[0]!.end, kind: 'go' };
  cards[1]!.start = '2026-09-29T17:00:00+02:00'; cards[1]!.end = '2026-09-29T19:00:00+02:00';
  cards[2]!.start = '2026-09-29T18:00:00+02:00'; cards[2]!.end = '2026-09-29T20:00:00+02:00';
  api.triage = { ...api.triage, feedState: 'ok', generatedAt: '2026-09-27T06:50:00+02:00', cards,
    checkins: [{ eventId: 'eeeeeeeeeeeeeeeeeeee', title: 'Synthetic past meetup', start: '2026-09-25T17:00:00+02:00' }] };
  await api.install(page); await page.goto('/');
  // UX8: event triage lives on the Scouts tab (see the first test).
  await goTo(page, 'Scouts');
  await page.getByRole('button', { name: '11 new events' }).click();
  const dialog = page.getByRole('dialog', { name: 'Event triage stack' });
  await expect(dialog.getByRole('region', { name: 'Event check-in' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Worth it', exact: true }).click();
  await expect(dialog.getByText('10 events waiting')).toBeVisible();
  await expect.poll(() => api.applied.map((c) => c.type === 'TriageDecide' ? c.payload.decision : c.type)).toEqual(['attended']);
  expect(api.applied[0]).toMatchObject({ payload: { decision: 'attended', outcome: 'worth', card: { title: 'Synthetic past meetup', category: null, sourceName: null, aiScore: null } } });
  await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Event check-in' })).toBeVisible();
  await expect.poll(() => api.applied.map((c) => c.type === 'TriageDecide' ? c.payload.decision : c.type)).toEqual(['attended', 'undo']);
  await dialog.getByRole('button', { name: "Didn't go" }).click();
  const first = dialog.getByRole('article', { name: /Synthetic event 1/ });
  await expect(first.getByText('Overlaps your Go: Synthetic saved Go')).toBeVisible();
  const text = await first.textContent();
  expect(text!.indexOf('Summary 1')).toBeLessThan(text!.indexOf('Synthetic hall'));
  expect(text!.indexOf('Why 1')).toBeGreaterThan(text!.indexOf('AI 80'));
  await dialog.getByRole('button', { name: 'Skip this event' }).click();
  await page.clock.fastForward(2500);
  await expect(dialog.getByRole('group', { name: 'Skip reason' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Not my topic' }).click();
  await dialog.getByRole('button', { name: 'Go: add to Calendar' }).click();
  await expect(dialog.getByText('Overlaps your Go: Synthetic event 2')).toBeVisible();
  await expect.poll(() => api.applied.some((c) => c.type === 'TriageDecide' && c.payload.decision === 'skip' && c.payload.reason === 'topic')).toBe(true);
});
