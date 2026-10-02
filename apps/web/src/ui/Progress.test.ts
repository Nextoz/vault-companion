import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem, HistoryResponse, Receipt } from '@vault-companion/contracts';
import { getHistory, getNotes, getTraining, getTriage, type Fetched } from '../api.ts';
import { completeTask } from '../commands.ts';
import { lastCopies } from '../lastCopy.ts';
import type { PendingQueue, QueueItem } from '../queue/queue.ts';
import { Progress } from './Progress.tsx';

vi.mock('../api.ts', () => ({ getHistory: vi.fn(), getNotes: vi.fn(), getTraining: vi.fn(), getTriage: vi.fn(), getNote: vi.fn() }));
vi.mock('./NoteView.tsx', () => ({ loadRenderer: () => Promise.resolve((body: string) => `<p>${body}</p>`), REFUSED: {} }));

const REV = '1'.repeat(40);
const ACCOUNT = 'a'.repeat(64);
const OPEN = '- [ ] Water the plants #todo';
const DONE = '- [x] Water the plants #todo ✅ 2026-09-26';
const item: HistoryItem = {
  source: 'todo', description: 'Water the plants', doneDate: '2026-09-26', links: [],
  locator: { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex: 5, lineText: DONE, occurrencesAtRead: 1 },
};
const complete = completeTask({ baseRevision: REV, now: new Date('2026-09-26T10:00:00Z') },
  { path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex: 1, lineText: OPEN, occurrencesAtRead: 1 });
const receipt: Receipt = {
  operationId: complete.operationId, status: 'applied', path: 'Tasks/To-Do List.md', commitSha: '5'.repeat(40), blobSha: '6'.repeat(40),
  effect: { kind: 'completed', completedLineText: DONE, openLineText: OPEN, completedInPlace: false, doneDate: '2026-09-26' },
};
const saved: QueueItem = { operationId: complete.operationId, seq: 1, type: complete.type, envelope: complete, label: 'Water the plants',
  taskKey: null, accountKey: ACCOUNT, state: 'saved', error: null, everSent: true, accountMismatch: false, receipt, acknowledged: true };
const history: HistoryResponse = { revision: REV, today: '2026-09-26', items: [item] };

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  lastCopies.clear();
  vi.mocked(getTraining).mockResolvedValue({ kind: 'offline' });
  vi.mocked(getTriage).mockResolvedValue({ kind: 'offline' });
  vi.mocked(getNotes).mockResolvedValue({ kind: 'offline' });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.resetAllMocks();
});

const mount = async () => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(createElement(Progress, {
    refreshKey: 1, queue: {} as PendingQueue, queued: [saved], accountKey: ACCOUNT, baseRevision: REV, blocked: false,
    onReopen: () => {}, onOpenLink: () => {},
  })));
};
const reopen = () => document.querySelector('button[aria-label^="Reopen"]');
const note = () => document.querySelector('[data-testid="copy-note"]')?.textContent ?? null;

describe('Progress opens from the last copy (SP3b, ADR-0038)', () => {
  it('shows the copied history at once, labelled, without Reopen until its own read answers', async () => {
    lastCopies.put(ACCOUNT, 'history', history, Date.now());
    let answer!: (r: Fetched<HistoryResponse>) => void;
    vi.mocked(getHistory).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    await mount();
    expect(document.querySelectorAll('[data-testid="history-item"]')).toHaveLength(1);
    expect(note()).toMatch(/^Showing the copy from \d\d:\d\d · refreshing…$/);
    expect(reopen()).toBeNull();
    await act(async () => answer({ kind: 'ok', data: history }));
    expect(note()).toBeNull();
    expect(reopen()).not.toBeNull();
  });

  it('a failed refresh keeps the copy, says so, and still offers no Reopen', async () => {
    lastCopies.put(ACCOUNT, 'history', history, Date.now());
    vi.mocked(getHistory).mockResolvedValue({ kind: 'offline' });
    await mount();
    expect(document.querySelectorAll('[data-testid="history-item"]')).toHaveLength(1);
    expect(note()).toMatch(/^Could not refresh · showing the copy from \d\d:\d\d$/);
    expect(reopen()).toBeNull();
  });

  it('without a copy it loads as before and saves the answer as the next copy', async () => {
    vi.mocked(getHistory).mockResolvedValue({ kind: 'ok', data: history });
    await mount();
    expect(note()).toBeNull();
    expect(reopen()).not.toBeNull();
    expect(lastCopies.get(ACCOUNT, 'history')?.data).toEqual(history);
  });
});
