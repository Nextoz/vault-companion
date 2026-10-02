import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteReadResponse } from '@vault-companion/contracts';
import { getNote, getNotes, type Fetched } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { Notes } from './Notes.tsx';

vi.mock('../api.ts', () => ({ getNote: vi.fn(), getNotes: vi.fn() }));
vi.mock('./NoteView.tsx', () => ({ loadRenderer: () => Promise.resolve((body: string) => `<p>${body}</p>`), REFUSED: {} }));

const SHA = 'a'.repeat(40);
const entry = { path: 'Inbox/Idea - 2026-10-01.md', title: 'Idea', date: '2026-10-01', blobSha: 'b'.repeat(40) };
const note = (body: string): Fetched<NoteReadResponse> => ({
  kind: 'ok',
  data: { status: 'ok', revision: SHA, path: entry.path, blobSha: 'b'.repeat(40), markdown: body, frontmatter: '', body },
});

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  lastCopies.clear();
  vi.mocked(getNotes).mockResolvedValue({ kind: 'ok', data: { revision: SHA, notes: [entry] } });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.resetAllMocks();
});

const mount = async () => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(createElement(Notes, { refreshKey: 0, queue: {} as PendingQueue, items: [], accountKey: 'acct', baseRevision: SHA }));
  });
};
const unmount = async () => { await act(async () => root!.unmount()); root = null; };
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const copyNote = () => document.querySelector('[data-testid="copy-note"]')?.textContent ?? null;
const editButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit') as HTMLButtonElement | undefined;

describe('Notes last copy (SP3, ADR-0038)', () => {
  it('reopens a note from the copy at once, never editable until the fresh read arrives', async () => {
    vi.mocked(getNote).mockResolvedValueOnce(note('first'));
    await mount();
    await flush();
    await click(document.querySelector('[data-testid="note-row"]'));
    await flush();
    expect(document.querySelector('[data-testid="note-body"]')?.innerHTML).toBe('<p>first</p>');
    expect(copyNote()).toBeNull();
    expect(editButton()?.disabled).toBe(false);
    await unmount();

    let answer!: (value: Fetched<NoteReadResponse>) => void;
    vi.mocked(getNote).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await mount();
    await click(document.querySelector('[data-testid="note-row"]'));
    await flush();
    expect(document.querySelector('[data-testid="note-body"]')?.innerHTML).toBe('<p>first</p>');
    expect(copyNote()).toMatch(/^Showing the copy from \d\d:\d\d · refreshing…$/);
    expect(editButton()?.disabled).toBe(true);

    await act(async () => { answer(note('second')); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="note-body"]')?.innerHTML).toBe('<p>second</p>');
    expect(copyNote()).toBeNull();
    expect(editButton()?.disabled).toBe(false);
  });

  it('keeps the copy on a failed refresh, says so, and still refuses Edit', async () => {
    vi.mocked(getNote).mockResolvedValueOnce(note('first'));
    await mount();
    await flush();
    await click(document.querySelector('[data-testid="note-row"]'));
    await flush();
    await unmount();

    vi.mocked(getNote).mockResolvedValueOnce({ kind: 'offline' });
    vi.mocked(getNotes).mockResolvedValueOnce({ kind: 'offline' });
    await mount();
    await flush();
    expect(copyNote()).toMatch(/^Could not refresh · showing the copy from/);
    await click(document.querySelector('[data-testid="note-row"]'));
    await flush();
    expect(document.querySelector('[data-testid="note-body"]')?.innerHTML).toBe('<p>first</p>');
    expect(copyNote()).toMatch(/^Could not refresh/);
    expect(editButton()?.disabled).toBe(true);
  });
});
