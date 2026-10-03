import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageResponse } from '@vault-companion/contracts';
import type { PendingQueue } from '../queue/queue.ts';
import { getTriage } from '../api.ts';
import { Triage } from './Triage.tsx';

vi.mock('../api.ts', () => ({ getTriage: vi.fn() }));

const now = '2026-09-30T22:30:00Z';
function checkinRead(): TriageResponse {
  return TriageResponse.parse({
    revision: 'a'.repeat(40), now, feedState: 'ok', generatedAt: now, droppedCards: 0, decisions: [], applied: {}, appliedUpdatedAt: now,
    cards: [], checkins: [{ eventId: 'eeeeeeeeeeeeeeeeeeee', title: 'Synthetic past meetup', start: '2026-09-25T17:00:00+02:00' }],
  });
}

describe('Triage check-in failure', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  });
  afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

  it('a failed attended command un-answers the check-in so it shows again', async () => {
    vi.mocked(getTriage).mockResolvedValue({ kind: 'ok', data: checkinRead() });
    const fakeQueue = { enqueue: vi.fn().mockRejectedValue(new Error('network')) } as unknown as PendingQueue;

    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(Triage, { queue: fakeQueue, items: [], accountKey: 'account', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { (document.querySelector('.triage-indicator') as HTMLButtonElement).click(); });

    const checkinSection = () => document.querySelector('[aria-label="Event check-in"]');
    expect(checkinSection()).not.toBeNull();
    const worthIt = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Worth it')!;
    await act(async () => { worthIt.click(); });

    expect(checkinSection()).not.toBeNull();
    expect(document.querySelector('.triage-undo')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The decision could not be saved. Please try again.');
    await act(async () => root.unmount());
  });
});

function laneCard(eventId: string, rank: number, category: string, title: string) {
  return { eventId, rank, resurfaced: false, start: '2026-10-03T16:00:00+02:00', end: null, title, summary: 'Synthetic summary.',
    location: 'Example hall', online: false, cost: 'Free', registration: { state: 'open', deadline: null }, aiScore: 70, explore: false,
    why: 'Synthetic rationale.', category, scouts: ['city-events'], sourceName: 'Example source', sourceUrl: 'https://example.org/e1',
    calendar: { inCalendar: null, clash: null, freeThatEvening: true } };
}
function laneRead(): TriageResponse {
  return TriageResponse.parse({ revision: 'a'.repeat(40), now, feedState: 'ok', generatedAt: now, droppedCards: 0, decisions: [], applied: {}, appliedUpdatedAt: now,
    cards: [laneCard('a'.repeat(20), 0, 'community', 'Community fair'), laneCard('b'.repeat(20), 1, 'technology', 'Tech meetup'), laneCard('c'.repeat(20), 2, 'sport', 'Sport day')] });
}

describe('Triage lane filter', () => {
  let dom: JSDOM;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  });
  afterEach(() => { vi.restoreAllMocks(); dom.window.close(); });

  it('shows the lane count and filters the stack while All restores feed order', async () => {
    vi.mocked(getTriage).mockResolvedValue({ kind: 'ok', data: laneRead() });
    const fakeQueue = { enqueue: vi.fn() } as unknown as PendingQueue;
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(Triage, { queue: fakeQueue, items: [], accountKey: 'account', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { (document.querySelector('.triage-indicator') as HTMLButtonElement).click(); });
    const titles = () => [...document.querySelectorAll('.triage-stage .triage-card h2')].map((h) => h.textContent);
    const topTitle = () => document.querySelector('.triage-stage .triage-card:not(.triage-next) h2')?.textContent;
    const filter = (label: string) => [...document.querySelectorAll('[aria-label="Event lane"] button')].find((b) => b.textContent === label) as HTMLButtonElement;

    expect(document.querySelector('.triage-lane-count')?.textContent).toBe('2 work · 1 culture');
    expect(topTitle()).toBe('Community fair');
    expect(filter('All').getAttribute('aria-pressed')).toBe('true');

    await act(async () => filter('Work').click());
    expect(topTitle()).toBe('Tech meetup');
    expect(titles()).not.toContain('Community fair');
    expect(filter('Work').getAttribute('aria-pressed')).toBe('true');

    await act(async () => filter('All').click());
    expect(titles()).not.toContain('Sport day');
    expect(topTitle()).toBe('Community fair');
    await act(async () => root.unmount());
  });
});
