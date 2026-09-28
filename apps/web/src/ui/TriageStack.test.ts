import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriageStack } from './TriageStack.tsx';
import type { TriageCardView } from '../triage.ts';

const card: TriageCardView = {
  eventId: 'aaaaaaaaaaaaaaaaaaaa', title: 'Synthetic evening workshop', summary: 'A synthetic summary.',
  start: '2026-10-03T17:00:00+02:00', end: '2026-10-03T18:00:00+02:00', location: 'Example hall', why: 'Synthetic rationale.',
  cost: 'Free', registration: { state: 'open', deadline: null }, aiScore: 80, explore: false,
  calendar: { inCalendar: null, clash: null, freeThatEvening: true },
};

describe('TriageStack skip reason window', () => {
  let dom: JSDOM;
  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  });
  afterEach(() => { vi.useRealTimers(); dom.window.close(); });

  it('stays open for three seconds, stays while hovered, then saves a null reason on leave', async () => {
    const onDecide = vi.fn();
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(TriageStack, { cards: [card], onDecide, onUndo() {} })));
    await act(async () => (document.querySelector('[aria-label="Skip this event"]') as HTMLButtonElement).click());
    const reasons = () => document.querySelector('[aria-label="Skip reason"]');
    expect(reasons()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(2500));
    expect(reasons()).not.toBeNull(); expect(onDecide).not.toHaveBeenCalled();
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(reasons()).not.toBeNull(); expect(onDecide).not.toHaveBeenCalled();
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerout', { bubbles: true })));
    expect(reasons()).toBeNull(); expect(onDecide).toHaveBeenCalledWith(card.eventId, 'skip', undefined);
    await act(async () => root.unmount());
  });

  it('a release while still hovered keeps the reason window open; leaving after expiry flushes', async () => {
    const onDecide = vi.fn();
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(TriageStack, { cards: [card], onDecide, onUndo() {} })));
    await act(async () => (document.querySelector('[aria-label="Skip this event"]') as HTMLButtonElement).click());
    const reasons = () => document.querySelector('[aria-label="Skip reason"]');
    expect(reasons()).not.toBeNull();
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true })));
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(3100));
    expect(reasons()).not.toBeNull(); expect(onDecide).not.toHaveBeenCalled();
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(0));
    expect(reasons()).not.toBeNull(); expect(onDecide).not.toHaveBeenCalled();
    await act(async () => reasons()!.dispatchEvent(new dom.window.Event('pointerout', { bubbles: true })));
    expect(reasons()).toBeNull(); expect(onDecide).toHaveBeenCalledWith(card.eventId, 'skip', undefined);
    await act(async () => root.unmount());
  });

  it('pre-selects "busy" for a clashing card when no reason is chosen', async () => {
    const onDecide = vi.fn();
    const clashing = { ...card, calendar: { ...card.calendar, clash: { title: 'Own entry', start: card.start, end: card.end!, kind: 'own' as const } } };
    const root = createRoot(document.getElementById('root')!);
    await act(async () => root.render(createElement(TriageStack, { cards: [clashing], onDecide, onUndo() {} })));
    await act(async () => (document.querySelector('[aria-label="Skip this event"]') as HTMLButtonElement).click());
    await act(async () => vi.advanceTimersByTime(3100));
    expect(onDecide).toHaveBeenCalledWith(clashing.eventId, 'skip', 'busy');
    await act(async () => root.unmount());
  });
});
