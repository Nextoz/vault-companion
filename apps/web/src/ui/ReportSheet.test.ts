import { ReportFeedbackCommand as ReportFeedback, type ReportFeedbackCommand } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PendingQueue } from '../queue/queue.ts';
import { appVersion, ReportSheet, screenName } from './ReportSheet.tsx';

let dom: JSDOM;
// Imported after the JSDOM globals exist, so React sees a browser and wires controlled inputs to native `input`.
let createRoot: typeof import('react-dom/client').createRoot;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
});

afterEach(() => { dom.window.close(); });

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;

async function mount(onClose: () => void = () => {}) {
  const enqueue = vi.fn().mockResolvedValue('enqueued');
  const queue = { enqueue } as unknown as PendingQueue;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(ReportSheet, {
      queue, accountKey: 'a'.repeat(64), baseRevision: '1'.repeat(40), screen: screenName('today'), onClose,
    }));
  });
  return { root, enqueue, onClose };
}

/** Type into React's controlled textarea: assign through the native setter so its input handler sees the change. */
async function type(value: string) {
  const textarea = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
  await act(async () => {
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

it('keeps Save disabled until the text is non-blank, then enqueues a valid Wish report', async () => {
  const { root, enqueue } = await mount();
  expect(button('Save').disabled).toBe(true);
  expect(document.querySelector('textarea')!.maxLength).toBe(1000);

  await act(async () => { button('Wish').click(); });
  expect(button('Wish').getAttribute('aria-pressed')).toBe('true');
  expect(button('Bug').getAttribute('aria-pressed')).toBe('false');
  expect(button('Save').disabled).toBe(true);

  await type('A synthetic wish');
  expect(button('Save').disabled).toBe(false);
  await act(async () => { button('Save').click(); });

  expect(enqueue).toHaveBeenCalledTimes(1);
  const [envelope, options] = enqueue.mock.calls[0]!;
  expect(ReportFeedback.safeParse(envelope).success).toBe(true);
  const payload = (envelope as ReportFeedbackCommand).payload;
  expect(payload).toMatchObject({ kind: 'wish', text: 'A synthetic wish', screen: 'Today', appVersion: appVersion() });
  expect(payload.screen).toMatch(/^[A-Za-z][A-Za-z0-9 -]{0,30}$/);
  expect(payload.appVersion).toMatch(/^[0-9A-Za-z.+-]{1,40}$/);
  expect(payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(options).toMatchObject({ accountKey: 'a'.repeat(64), taskKey: 'report' });
  expect(options.label).toContain('Report');
  expect(options.label).not.toContain('wish');
  await act(async () => root.unmount());
});

it('Cancel closes without enqueuing', async () => {
  const onClose = vi.fn();
  const { root, enqueue } = await mount(onClose);
  await type('discard me');
  await act(async () => { button('Cancel').click(); });
  expect(onClose).toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('names every tab the way the screen field requires', () => {
  expect(screenName('tasks')).toBe('Tasks');
  expect(screenName('history')).toBe('Progress');
  expect(screenName('health')).toBe('Health');
  for (const tab of ['today', 'tasks', 'all', 'notes', 'training', 'scouts', 'history']) {
    expect(screenName(tab)).toMatch(/^[A-Za-z][A-Za-z0-9 -]{0,30}$/);
  }
});
