import { TriageResponse } from '@vault-companion/contracts';
import { createCommandService, createTriageService, StoreUnavailable } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from './app.ts';

afterEach(() => vi.restoreAllMocks());
it('triage route requires auth, is no-store, omits content from logs, and maps outages', async () => {
  const now = '2026-09-27T12:00:00Z';
  const card = { eventId: '0a1b2c3d4e5f60718293', rank: 1, explore: false, resurfaced: false, title: 'Evening talk on city gardens',
    start: '2026-09-29T17:00:00+02:00', end: null, location: 'Community hall', online: false, cost: 'Free',
    registration: { state: 'open', deadline: '2026-09-28T23:59:00+02:00' }, aiScore: 88, why: 'Hands-on and close by.',
    category: 'community', scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1',
    calendar: { inCalendar: 'auto', clash: { title: 'Gym class', start: '2026-09-29T17:30:00+02:00', end: '2026-09-29T18:30:00+02:00' }, freeThatEvening: false } };
  const checkin = { eventId: 'aaaaaaaaaaaaaaaaaaaa', title: 'Synthetic past workshop', start: '2026-09-25T17:00:00+02:00' };
  const store = await InMemoryStore.create({ 'Events/Triage/feed.json': JSON.stringify({ schemaVersion: 1, generatedAt: now, cards: [card],
    checkins: [checkin, { ...checkin, eventId: 'bad' }] }) });
  const logs: unknown[] = [];
  const consoleCalls: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args) => { consoleCalls.push(args); });
  const deps = { store, now: () => new Date(now), timeZone: 'Europe/Copenhagen' };
  const commands = createCommandService(deps);
  const make = (wired = true) => createApp({ appOrigin: 'https://example.org', log: (r) => logs.push(r),
    verify: async (token) => token === 'good' ? { ok: true, email: 'owner@example.org', accountKey: 'a'.repeat(64) } : { ok: false },
    services: wired ? { ...commands, ...createTriageService(deps) } : commands });
  const head = vi.spyOn(store, 'head');
  expect((await make().request('/api/triage')).status).toBe(401);
  expect(head).not.toHaveBeenCalled();
  const get = (wired = true) => make(wired).request('/api/triage', { headers: { 'Cf-Access-Jwt-Assertion': 'good' } });
  const result = await get();
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  expect(TriageResponse.parse(await result.json())).toMatchObject({ feedState: 'ok', cards: [card], checkins: [checkin], droppedCheckins: 1 });
  expect((await get(false)).status).toBe(404);
  vi.spyOn(store, 'listFiles').mockRejectedValue(new StoreUnavailable('down'));
  const failed = await get();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ code: 'upstream-unavailable', retryable: true });
  for (const secret of [card.title, card.why, card.calendar.clash.title, checkin.title, 'Events/Triage']) expect(JSON.stringify([logs, consoleCalls])).not.toContain(secret);
});
