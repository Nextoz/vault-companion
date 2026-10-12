import type { BookView } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingQueue } from '../queue/queue.ts';
import { ReadingSheet } from './ReadingSheet.tsx';

let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;

const book: BookView = { title: 'Synthetic Book', author: 'A. Author', totalPages: 200, currentPage: 40,
  status: 'reading', lastRead: '2026-10-01', reflections: [] };

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
});

afterEach(() => { dom.window.close(); vi.clearAllMocks(); });

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const label = (text: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text));

async function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

function queueMock() {
  const enqueue = vi.fn().mockResolvedValue('enqueued');
  return { queue: { enqueue } as unknown as PendingQueue, enqueue };
}

async function render(element: ReactElement) {
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(element); });
  return root;
}

const common = { accountKey: 'a'.repeat(64), baseRevision: '1'.repeat(40), onClose: () => {}, now: new Date('2026-10-11T12:00:00Z') };

describe('ReadingSheet start', () => {
  it('needs title, author and pages before it can start a book, then sends a number', async () => {
    const { queue, enqueue } = queueMock();
    await render(createElement(ReadingSheet, { ...common, queue, kind: 'start' }));
    expect(button('Start book')!.hasAttribute('disabled')).toBe(true);

    await setValue(label('Title')!.querySelector('input')!, 'Synthetic Book');
    await setValue(label('Author')!.querySelector('input')!, 'A. Author');
    await setValue(label('Total pages')!.querySelector('input')!, '200');
    expect(button('Start book')!.hasAttribute('disabled')).toBe(false);
    await act(async () => { button('Start book')!.click(); });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ type: 'StartBook', payload: { title: 'Synthetic Book', author: 'A. Author', totalPages: 200 } });
    expect(typeof enqueue.mock.calls[0]![0].payload.totalPages).toBe('number');
  });

  it('starts a book with only a title (author and pages optional, e.g. an audiobook)', async () => {
    const { queue, enqueue } = queueMock();
    await render(createElement(ReadingSheet, { ...common, queue, kind: 'start' }));
    await setValue(label('Title')!.querySelector('input')!, 'Audio Walk');
    expect(button('Start book')!.hasAttribute('disabled')).toBe(false);
    await act(async () => { button('Start book')!.click(); });
    expect(enqueue.mock.calls[0]![0].payload).toEqual({ title: 'Audio Walk', author: '' });
  });
});

describe('ReadingSheet log', () => {
  it('prefills the page the reader is on, blocks a lower page in plain words, and logs a higher one with today', async () => {
    const { queue, enqueue } = queueMock();
    await render(createElement(ReadingSheet, { ...common, queue, kind: 'log', book }));
    const page = label('Page')!.querySelector('input')!;
    expect(page.value).toBe('40');
    expect(label('Date')!.querySelector('input')!.value).toBe('2026-10-11');

    await setValue(page, '12');
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/before where you are/);
    expect(button('Save')!.hasAttribute('disabled')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();

    await setValue(page, '55');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { button('Save')!.click(); });
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ type: 'LogReading', payload: { title: 'Synthetic Book', page: 55, date: '2026-10-11' } });
  });
});
describe('ReadingSheet reflect', () => {
  function Host({ queue, onDraftChange }: { queue: PendingQueue; onDraftChange: (text: string) => void }) {
    const [draft, setDraft] = useState('');
    return createElement(ReadingSheet, { ...common, queue, kind: 'reflect', book, draft,
      onDraftChange: (text) => { setDraft(text); onDraftChange(text); } });
  }
  it('disables Save for empty or whitespace text and never puts the text in the action label', async () => {
    const { queue, enqueue } = queueMock();
    const onDraftChange = vi.fn();
    await render(createElement(Host, { queue, onDraftChange }));
    const textarea = label('What stayed with me?')!.querySelector('textarea')!;
    expect(button('Save')!.hasAttribute('disabled')).toBe(true);
    await setValue(textarea, '   ');
    expect(button('Save')!.hasAttribute('disabled')).toBe(true);

    await setValue(textarea, 'A synthetic thought.');
    await act(async () => { button('Save')!.click(); });
    const envelope = enqueue.mock.calls[0]![0];
    expect(envelope).toMatchObject({ type: 'SaveReflection', payload: { title: 'Synthetic Book', text: 'A synthetic thought.' } });
    const options = enqueue.mock.calls[0]![1] as { label: string };
    expect(options.label).not.toContain('A synthetic thought.');
    expect(onDraftChange).toHaveBeenLastCalledWith('');
  });
});