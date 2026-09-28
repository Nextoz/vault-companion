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
