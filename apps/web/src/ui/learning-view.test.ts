import { LearningResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLearning } from '../api.ts';
import { Learning } from './Learning.tsx';

vi.mock('../api.ts', () => ({ getLearning: vi.fn() }));

let dom: JSDOM;
let createRoot: typeof import('react-dom/client').createRoot;

const base = () => ({
  status: 'ok', revision: '1'.repeat(40), blobSha: '2'.repeat(40), unknownLines: [],
  kinds: [{ id: 'dictation', name: 'Dictation', scoreMeans: 'accuracy', status: 'active' }],
  rows: [{ date: '2026-10-04', kind: 'dictation', minutes: '15', score: '3/5', detail: 'acc 8', topic: 'weather report', note: 'quiet room' }],
});

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
});

afterEach(() => { dom.window.close(); vi.clearAllMocks(); });

async function mount(data: unknown, accountKey = 'a'.repeat(64)) {
  vi.mocked(getLearning).mockResolvedValue(data as never);
  document.body.replaceChildren();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Learning, { refreshKey: null, accountKey })); });
  return root;
}

describe('Learning', () => {
  it('names rows from the read, shows effort and quality separately, and prints no streak/target text', async () => {
    await mount({ kind: 'ok', data: LearningResponse.parse({ ...base(), rows: [
      { date: '2026-10-04', kind: 'dictation', minutes: '15', score: '3/5', detail: 'acc 8', topic: 'weather report', note: 'quiet room' },
      { date: '2026-10-03', kind: 'mystery', minutes: '', score: '', detail: '', topic: '', note: '' },
    ] }) });
    const text = document.body.textContent ?? '';
    expect(text).toContain('Dictation');
    expect(text).toContain('15 min');
    expect(text).toContain('score 3/5');
    expect(text).toContain('mystery'); // unknown kind id falls back to itself, the list still renders
    expect(document.querySelectorAll('[data-testid="learning-row"]')).toHaveLength(2);
    expect(text).not.toMatch(/streak|target|goal|missed/i);
  });

  it('draws a trend only for kinds with at least two numeric scores', async () => {
    await mount({ kind: 'ok', data: LearningResponse.parse({ ...base(), rows: [
      { date: '2026-10-04', kind: 'dictation', minutes: '15', score: '4/5', detail: '', topic: '', note: '' },
      { date: '2026-10-03', kind: 'dictation', minutes: '15', score: '3/5', detail: '', topic: '', note: '' },
      { date: '2026-10-02', kind: 'verbs', minutes: '10', score: '7', detail: '', topic: '', note: '' },
    ] }) });
    expect(document.querySelectorAll('[data-testid="learning-trend"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="learning-trend"]')?.textContent).toContain('Dictation');
  });

  it('never fabricates rows: absent says the log is missing, refused shows the server text', async () => {
    await mount({ kind: 'ok', data: { status: 'absent', revision: '1'.repeat(40) } });
    expect(document.body.textContent).toContain('Learning Gym Log not found');
    expect(document.querySelectorAll('[data-testid="learning-row"]')).toHaveLength(0);

    await mount({ kind: 'ok', data: { status: 'refused', revision: '1'.repeat(40), code: 'refused:learning-table-missing', message: 'Learning Gym Log table not found — fix it in Obsidian' } });
    expect(document.body.textContent).toContain('Learning Gym Log table not found');
    expect(document.querySelectorAll('[data-testid="learning-row"]')).toHaveLength(0);
  });

  it('says a failed read could not be loaded instead of showing rows', async () => {
    await mount({ kind: 'error', message: 'The server answered 503.' }, 'b'.repeat(64));
    expect(document.body.textContent).toContain('Learning could not be loaded');
    expect(document.querySelectorAll('[data-testid="learning-row"]')).toHaveLength(0);
  });
});
