import { LearningResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLearning } from '../api.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { LearningSheet } from './LearningSheet.tsx';

vi.mock('../api.ts', () => ({ getLearning: vi.fn() }));

let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;

const kinds = [
  { id: 'dictation', name: 'Dictation', scoreMeans: 'accuracy', status: 'active' },
  { id: 'verbs', name: 'Verbs', scoreMeans: 'correct', status: 'planned' },
];

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
  vi.mocked(getLearning).mockResolvedValue({ kind: 'ok', data: LearningResponse.parse({
    status: 'ok', revision: '1'.repeat(40), blobSha: '2'.repeat(40), kinds, rows: [], unknownLines: [],
  }) });
});

afterEach(() => { dom.window.close(); vi.clearAllMocks(); });

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const label = (text: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text));

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

async function mount() {
  const enqueue = vi.fn().mockResolvedValue('enqueued');
  const queue = { enqueue } as unknown as PendingQueue;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(createElement(LearningSheet, { queue, accountKey: 'a'.repeat(64), baseRevision: '1'.repeat(40), onClose: () => {}, now: new Date('2026-10-04T09:00:00Z') })); });
  return { root, enqueue };
}

describe('LearningSheet', () => {
  it('draws the kind chips from the read, with no kind list in code', async () => {
    await mount();
    expect(button('Dictation')).toBeTruthy();
    expect(button('Verbs')).toBeTruthy(); // a planned kind is still selectable
    expect(button('Reading')).toBeUndefined();
    expect(button('Gym')).toBeUndefined();
  });

  it('saves date plus kind in two taps and omits empty minutes (never 0)', async () => {
    const { enqueue } = await mount();
    await act(async () => { button('Dictation')!.click(); });
    await act(async () => { button('Save')!.click(); });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const envelope = enqueue.mock.calls[0]![0];
    expect(envelope).toMatchObject({ type: 'LogLearning', payload: { session: { kind: 'dictation', date: '2026-10-04' } } });
    expect('minutes' in envelope.payload.session).toBe(false);
  });

  it('fills every field from a pasted line, keeping a 3/5 score as a ratio', async () => {
    const { enqueue } = await mount();
    await setValue(label('Paste line')!.querySelector('input')!, 'LG | dictation | 2026-10-03 | min 12 | score 3/5 | acc 8 | topic: weather report');
    expect(label('Date')!.querySelector('input')!.value).toBe('2026-10-03');
    expect(label('Minutes (optional)')!.querySelector('input')!.value).toBe('12');
    expect(label('Score (optional)')!.querySelector('input')!.value).toBe('3/5');
    expect(label('Detail (optional)')!.querySelector('input')!.value).toBe('acc 8');
    expect(label('Topic (optional)')!.querySelector('input')!.value).toBe('weather report');
    await act(async () => { button('Save')!.click(); });
    const envelope = enqueue.mock.calls[0]![0];
    expect(envelope.payload.session).toMatchObject({ kind: 'dictation', minutes: 12, score: '3/5', detail: 'acc 8', topic: 'weather report' });
    expect(envelope.payload.session.score).not.toBe(3);
  });

  it('shows an inline message and changes nothing for a refused paste', async () => {
    await mount();
    await setValue(label('Paste line')!.querySelector('input')!, 'not a learning line');
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/does not match/i);
    expect(label('Date')!.querySelector('input')!.value).toBe('2026-10-04');
    expect(label('Minutes (optional)')!.querySelector('input')!.value).toBe('');
    expect(button('Dictation')!.getAttribute('aria-pressed')).toBe('false');
  });
});
