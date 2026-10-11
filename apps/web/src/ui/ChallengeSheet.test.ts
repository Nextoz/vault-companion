import { JSDOM } from 'jsdom';
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingQueue } from '../queue/queue.ts';
import { ChallengeSheet } from './ChallengeSheet.tsx';

let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const reflection = { title: 'Synthetic Book', date: '2026-10-05', ordinal: 2, text: 'A synthetic reflection.' };
const common = { ...reflection, accountKey: 'a'.repeat(64), baseRevision: '1'.repeat(40), onClose: () => {} };

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
});

afterEach(() => { dom.window.close(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const label = (text: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text));

async function setValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

function queueMock() {
  const enqueue = vi.fn().mockResolvedValue('enqueued');
  return { queue: { enqueue } as unknown as PendingQueue, enqueue };
}

/** Renders the sheet and lets the on-open follow-up call settle. */
async function open(element: ReactElement) {
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(element); });
  await act(async () => {});
  return root;
}

describe('ChallengeSheet', () => {
  it('asks on open, sends the reflection selection, and shows the question marked as AI', async () => {
    const { queue } = queueMock();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ question: 'What did that change for you?' }));
    vi.stubGlobal('fetch', fetchMock);
    await open(createElement(ChallengeSheet, { ...common, queue }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/books/follow-up');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ title: 'Synthetic Book', date: '2026-10-05', ordinal: 2 });
    expect(document.querySelector('.ai-badge')?.textContent).toBe('AI question');
    expect(document.querySelector('.challenge-question')?.textContent).toBe('What did that change for you?');
    expect(document.body.textContent).toContain('A synthetic reflection.');
  });

  it('never enqueues without a non-blank answer', async () => {
    const { queue, enqueue } = queueMock();
    vi.stubGlobal('fetch', vi.fn(async () => json({ question: 'Is that so?' })));
    await open(createElement(ChallengeSheet, { ...common, queue }));

    await act(async () => { button('Save answer')!.click(); });
    expect(enqueue).not.toHaveBeenCalled();
    await setValue(label('Your answer')!.querySelector('textarea')!, '   ');
    expect(button('Save answer')!.hasAttribute('disabled')).toBe(true);
    await act(async () => { button('Save answer')!.click(); });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues SaveFollowUp with the exact payload and keeps the answer out of the label', async () => {
    const { queue, enqueue } = queueMock();
    vi.stubGlobal('fetch', vi.fn(async () => json({ question: 'Is that so?' })));
    await open(createElement(ChallengeSheet, { ...common, queue }));

    await setValue(label('Your answer')!.querySelector('textarea')!, 'A synthetic answer.');
    await act(async () => { button('Save answer')!.click(); });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ type: 'SaveFollowUp',
      payload: { title: 'Synthetic Book', date: '2026-10-05', ordinal: 2, question: 'Is that so?', answer: 'A synthetic answer.' } });
    expect((enqueue.mock.calls[0]![1] as { label: string }).label).not.toContain('A synthetic answer.');
  });

  it('shows the honest message with a Retry and never retries on its own', async () => {
    const { queue } = queueMock();
    const fetchMock = vi.fn(async () => json({ code: 'follow-up-rate-limited', message: 'Too many.', retryable: false }, 429));
    vi.stubGlobal('fetch', fetchMock);
    const root = await open(createElement(ChallengeSheet, { ...common, queue }));

    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Today's limit of AI questions is used up.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button('Retry')).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () => json({ question: 'Is that so?' })));
    await act(async () => { button('Retry')!.click(); });
    await act(async () => {});
    expect(document.querySelector('.challenge-question')?.textContent).toBe('Is that so?');
    await act(async () => { root.unmount(); });
  });
});
