import { RadarResponse, Receipt, ResearchRadarDecideCommand, type RadarPaper } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRadar, getRadarNote, postRadarDecision } from '../api.ts';
import { deriveRadar, ResearchRadar, type RadarIntent } from './ResearchRadar.tsx';

vi.mock('../api.ts', () => ({ getRadar: vi.fn(), getRadarNote: vi.fn(), postRadarDecision: vi.fn() }));

const REV = 'a'.repeat(40);
const OP = '22222222-2222-4222-8222-222222222222';
const paperId = (n: number) => n.toString(16).padStart(20, '0');

const paper = (n: number, over: Partial<RadarPaper> = {}): RadarPaper => ({
  paperId: paperId(n),
  rank: n,
  title: `Paper ${n}`,
  why: `Why paper ${n}`,
  topic: n % 2 ? 'rl' : 'transformers',
  sourceUrl: `https://example.com/paper-${n}`,
  sourceDate: '2026-09-29',
  badges: [],
  read: { kind: 'source', url: `https://example.com/paper-${n}` },
  ...over,
});

const response = (papers: RadarPaper[], decisions: RadarResponse['decisions'] = [], applied: RadarResponse['applied'] = {}): RadarResponse =>
  RadarResponse.parse({
    revision: REV,
    now: '2026-09-30T10:00:00Z',
    sources: {
      dailyScout: { state: 'ok', count: papers.length },
      readingBriefs: { state: 'absent', count: 0 },
      importantUpdates: { state: 'absent', count: 0 },
      explained: { state: 'absent', count: 0 },
    },
    papers,
    topics: [...new Set(papers.map((p) => p.topic))]
      .map((topic) => ({ topic, count: papers.filter((p) => p.topic === topic).length }))
      .sort((a, b) => b.count - a.count || (a.topic < b.topic ? -1 : 1)),
    decisions,
    applied,
    appliedUpdatedAt: null,
    warnings: [],
  });

const decision = (over: Partial<RadarResponse['decisions'][number]> = {}): RadarResponse['decisions'][number] => ({
  schemaVersion: 1,
  decisionId: OP,
  paperId: paperId(1),
  decision: 'keep',
  undoes: null,
  at: '2026-09-30T10:00:00Z',
  card: { title: 'Paper 1', source: 'https://example.com/paper-1', topic: 'rl' },
  ...over,
});

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});

afterEach(() => {
  vi.restoreAllMocks();
  dom.window.close();
});

async function render() {
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(ResearchRadar, { accountKey: 'account', refreshKey: null, blocked: false }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return root;
}

async function open() {
  await act(async () => {
    (document.querySelector('.group-toggle') as HTMLButtonElement).click();
  });
}

async function flush(extra = 4) {
  await act(async () => {
    for (let i = 0; i < extra; i++) await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('ResearchRadar component', () => {
  it('Lead review: note reads still finish under the app StrictMode lifecycle', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([
      paper(1, { read: { kind: 'note', path: 'Research/Explained/Paper 1.md' } }),
    ]) });
    vi.mocked(getRadarNote).mockResolvedValue({ kind: 'ok', data: {
      status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md',
      blobSha: 'b'.repeat(40), markdown: '# Synthetic StrictMode note',
    } });
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(StrictMode, null,
        createElement(ResearchRadar, { accountKey: 'account', refreshKey: null, blocked: false })));
    });
    await open();
    await act(async () => { (document.querySelector('.radar-read') as HTMLButtonElement).click(); });
    await flush(8);
    const displayed = document.querySelector('[data-testid="radar-note-view"]')?.textContent;
    await act(async () => root.unmount());
    expect(displayed).toContain('Synthetic StrictMode note');
  });
  it('starts collapsed and opens/closes the paper list', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1)]) });
    await render();
    expect((document.querySelector('.group-toggle') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="radar-card"]')).toBeNull();
    await open();
    expect(document.querySelector('[data-testid="radar-card"]')).not.toBeNull();
    await open();
    expect(document.querySelector('[data-testid="radar-card"]')).toBeNull();
  });

  it('shows three ranked cards and topic chips', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1), paper(2), paper(3)]) });
    await render();
    await open();
    expect(document.querySelectorAll('[data-testid="radar-card"]')).toHaveLength(3);
    const chips = [...document.querySelectorAll('.radar-topics .chip')].map((el) => el.textContent);
    expect(chips).toContain('rl · 2');
    expect(chips).toContain('transformers · 1');
  });

  it('opens preferred explanation/note reads server-side and keeps only a safe http(s) source link', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([
      paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } }),
      paper(2, { read: { kind: 'note', path: 'Research/Reading Briefs/brief.md' } }),
      paper(3),
    ]) });
    vi.mocked(getRadarNote).mockResolvedValue({ kind: 'ok', data: {
      status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md', blobSha: 'b'.repeat(40),
      markdown: '# Explanation\n\nSynthetic **note** text.',
    } });
    await render();
    await open();
    const reads = [...document.querySelectorAll('.radar-read')];
    expect(reads.map((el) => el.getAttribute('data-read-kind'))).toEqual(['explanation', 'note', 'source']);
    const sourceLink = reads[2] as HTMLAnchorElement;
    expect(sourceLink.getAttribute('href')).toMatch(/^https:\/\/example\.com\/paper-3$/);
    expect(sourceLink.getAttribute('target')).toBe('_blank');
    expect(sourceLink.getAttribute('rel')).toBe('noreferrer');
    expect((reads[0] as HTMLButtonElement).tagName).toBe('BUTTON');

    await act(async () => { (reads[0] as HTMLButtonElement).click(); });
    await flush();
    expect(vi.mocked(getRadarNote)).toHaveBeenCalledExactlyOnceWith(paperId(1));
    expect(document.querySelector('[data-testid="radar-note-view"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="radar-note-view"]')?.textContent).toContain('Explanation');
    expect(document.querySelector('[data-testid="radar-note-view"]')?.textContent).toContain('note');

    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Back to papers')!.click(); });
    await flush();
    expect(document.querySelector('[data-testid="radar-note-view"]')).toBeNull();
    expect([...document.querySelectorAll('a')].some((a) => /javascript:/.test(a.getAttribute('href') ?? ''))).toBe(false);
  });

  it('shows a typed refused Radar note message without falling back to a raw path', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([
      paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } }),
    ]) });
    vi.mocked(getRadarNote).mockResolvedValue({ kind: 'ok', data: {
      status: 'refused', revision: REV, code: 'missing', message: 'this paper has no readable Radar note',
    } });
    await render();
    await open();
    const read = [...document.querySelectorAll('.radar-read')][0] as HTMLButtonElement;
    await act(async () => { read.click(); });
    await flush();
    expect(document.querySelector('[data-testid="radar-note-view"]')?.textContent).toContain('this paper has no readable Radar note');
    expect(document.querySelector('[data-testid="radar-note-view"] article')).toBeNull();
  });

  it('discards a stale Radar note read after an account switch', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } })]) });
    const gate = deferred<Awaited<ReturnType<typeof getRadarNote>>>();
    vi.mocked(getRadarNote).mockReturnValue(gate.promise);
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-a', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    const read = [...document.querySelectorAll('.radar-read')][0] as HTMLButtonElement;
    await act(async () => { read.click(); });
    await flush(1);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-b', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    gate.resolve({ kind: 'ok', data: { status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md', blobSha: 'b'.repeat(40), markdown: '# Stale account note' } });
    await flush(8);
    expect(document.querySelector('[data-testid="radar-note-view"]')).toBeNull();
  });

  it('discards a stale Radar note read after sign-out', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } })]) });
    const gate = deferred<Awaited<ReturnType<typeof getRadarNote>>>();
    vi.mocked(getRadarNote).mockReturnValue(gate.promise);
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-a', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    const read = [...document.querySelectorAll('.radar-read')][0] as HTMLButtonElement;
    await act(async () => { read.click(); });
    await flush(1);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: null, refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    gate.resolve({ kind: 'ok', data: { status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md', blobSha: 'b'.repeat(40), markdown: '# Stale signed-out note' } });
    await flush(8);
    expect(document.querySelector('[data-testid="radar-note-view"]')).toBeNull();
  });

  it('discards a stale Radar note read after the account becomes blocked', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } })]) });
    const gate = deferred<Awaited<ReturnType<typeof getRadarNote>>>();
    vi.mocked(getRadarNote).mockReturnValue(gate.promise);
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-a', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    const read = [...document.querySelectorAll('.radar-read')][0] as HTMLButtonElement;
    await act(async () => { read.click(); });
    await flush(1);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-a', refreshKey: null, blocked: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    gate.resolve({ kind: 'ok', data: { status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md', blobSha: 'b'.repeat(40), markdown: '# Stale blocked note' } });
    await flush(8);
    expect(document.querySelector('[data-testid="radar-note-view"]')).toBeNull();
  });

  it('keeps only the newest Radar note read when an older request resolves later', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([
      paper(1, { read: { kind: 'explanation', path: 'Research/Explained/Paper 1.md' } }),
      paper(2, { read: { kind: 'explanation', path: 'Research/Explained/Paper 2.md' } }),
    ]) });
    const first = deferred<Awaited<ReturnType<typeof getRadarNote>>>();
    vi.mocked(getRadarNote)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ kind: 'ok', data: { status: 'ok', revision: REV, path: 'Research/Explained/Paper 2.md', blobSha: 'b'.repeat(40), markdown: '# Second note' } });
    await render();
    await open();
    const reads = [...document.querySelectorAll('.radar-read')] as HTMLButtonElement[];
    await act(async () => { reads[0]!.click(); });
    await flush(1);
    await act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Back to papers')!.click(); });
    await flush();
    const secondRead = [...document.querySelectorAll('.radar-read')][1] as HTMLButtonElement;
    await act(async () => { secondRead.click(); });
    await flush();
    first.resolve({ kind: 'ok', data: { status: 'ok', revision: REV, path: 'Research/Explained/Paper 1.md', blobSha: 'b'.repeat(40), markdown: '# Stale first note' } });
    await flush(8);
    expect(document.querySelector('[data-testid="radar-note-view"]')?.textContent).toContain('Second note');
    expect(document.querySelector('[data-testid="radar-note-view"]')?.textContent).not.toContain('Stale first note');
  });

  it('Remove optimistically hides the card and a refresh promotes the fourth item', async () => {
    const initial = response([paper(1), paper(2), paper(3)]);
    const after = response([paper(2), paper(3), paper(4)]);
    vi.mocked(getRadar)
      .mockResolvedValueOnce({ kind: 'ok', data: initial })
      .mockResolvedValueOnce({ kind: 'ok', data: after });
    vi.mocked(postRadarDecision).mockImplementation(async (body) => {
      const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
      return new Response(JSON.stringify(Receipt.parse({
        operationId: command.operationId,
        status: 'applied',
        path: 'Research/Radar/Decisions/2026-09.jsonl',
        commitSha: REV,
        blobSha: 'b'.repeat(40),
        effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await render();
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { remove.click(); });
    await flush();
    expect([...document.querySelectorAll('[data-testid="radar-card"] h3')].map((el) => el.textContent)).toEqual(['Paper 2', 'Paper 3', 'Paper 4']);
  });

  it('Undo restores the underlying paper and removes the decision entry', async () => {
    const removeLine = decision({ decision: 'remove' });
    const initial = response([paper(1), paper(2), paper(3)], [removeLine]);
    const restored = response([paper(1), paper(2), paper(3)], []);
    vi.mocked(getRadar)
      .mockResolvedValueOnce({ kind: 'ok', data: initial })
      .mockResolvedValueOnce({ kind: 'ok', data: restored });
    vi.mocked(postRadarDecision).mockImplementation(async (body) => {
      const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
      return new Response(JSON.stringify(Receipt.parse({
        operationId: command.operationId,
        status: 'applied',
        path: 'Research/Radar/Decisions/2026-09.jsonl',
        commitSha: REV,
        blobSha: 'b'.repeat(40),
        effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await render();
    await open();
    expect(document.querySelectorAll('[data-testid="radar-card"]')).toHaveLength(2);
    const undo = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    await flush();
    expect(document.querySelectorAll('[data-testid="radar-card"]')).toHaveLength(3);
    expect(document.querySelector('[data-testid="radar-decision"]')).toBeNull();
  });

  it('offline failure keeps the intent with a Retry action, then a retry succeeds', async () => {
    const initial = response([paper(1), paper(2), paper(3)]);
    const after = response([paper(2), paper(3)]);
    vi.mocked(getRadar)
      .mockResolvedValueOnce({ kind: 'ok', data: initial })
      .mockResolvedValueOnce({ kind: 'ok', data: after });
    vi.mocked(postRadarDecision)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(async (body) => {
        const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
        return new Response(JSON.stringify(Receipt.parse({
          operationId: command.operationId,
          status: 'applied',
          path: 'Research/Radar/Decisions/2026-09.jsonl',
          commitSha: REV,
          blobSha: 'b'.repeat(40),
          effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    await render();
    await open();
    const keep = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Keep')!;
    await act(async () => { keep.click(); });
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('waiting to retry');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
    expect(document.querySelector('[data-testid="radar-decision"]')).not.toBeNull();

    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => { retry.click(); });
    await flush();
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(false);
    expect(document.querySelector('[data-testid="radar-decision"]')).toBeNull();
  });

  it('keeps an offline pending intent across a remount without silently resending', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1), paper(2), paper(3)]) });
    vi.mocked(postRadarDecision).mockRejectedValue(new TypeError('Failed to fetch'));
    const root = await render();
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { remove.click(); });
    await flush();
    expect(document.querySelector('[data-testid="radar-decision"]')).not.toBeNull();
    expect(JSON.parse(dom.window.localStorage.getItem('vault-companion:radar-pending:v1:account') ?? '[]')).toHaveLength(1);

    await act(async () => root.unmount());
    const next = createRoot(document.getElementById('root')!);
    await act(async () => {
      next.render(createElement(ResearchRadar, { accountKey: 'account', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    await flush();
    expect(document.querySelector('[data-testid="radar-decision"]')).not.toBeNull();
    expect(vi.mocked(postRadarDecision)).toHaveBeenCalledTimes(1);
  });

  it('queues an Undo after its offline original is durably acknowledged, never sending it first', async () => {
    const initial = response([paper(1), paper(2), paper(3)]);
    const restored = response([paper(1), paper(2), paper(3)], []);
    let firstRemoveId = '';
    vi.mocked(getRadar)
      .mockResolvedValueOnce({ kind: 'ok', data: initial })
      .mockImplementationOnce(async () => ({ kind: 'ok', data: response([paper(2), paper(3)], [decision({ decision: 'remove', decisionId: firstRemoveId })]) }))
      .mockResolvedValueOnce({ kind: 'ok', data: restored });
    vi.mocked(postRadarDecision)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(async (body) => {
        const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
        firstRemoveId = command.operationId;
        return new Response(JSON.stringify(Receipt.parse({
          operationId: command.operationId,
          status: 'applied',
          path: 'Research/Radar/Decisions/2026-09.jsonl',
          commitSha: REV,
          blobSha: 'b'.repeat(40),
          effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } });
      })
      .mockImplementationOnce(async (body) => {
        const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
        return new Response(JSON.stringify(Receipt.parse({
          operationId: command.operationId,
          status: 'applied',
          path: 'Research/Radar/Decisions/2026-09.jsonl',
          commitSha: REV,
          blobSha: 'b'.repeat(40),
          effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
    await render();
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { remove.click(); });
    await flush();
    expect(vi.mocked(postRadarDecision)).toHaveBeenCalledTimes(1);

    const undo = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
    await act(async () => { undo.click(); });
    await flush();
    expect(vi.mocked(postRadarDecision)).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('[data-testid="radar-decision"]')]).toHaveLength(2);
    expect([...document.querySelectorAll('.radar-decision-title')].some((el) => el.textContent === 'Paper 1')).toBe(true);

    const removedDecision = [...document.querySelectorAll('.radar-decision')].find((el) => el.textContent?.startsWith('Removed'))!;
    const retry = [...removedDecision.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => { retry.click(); });
    await flush();
    const commands = vi.mocked(postRadarDecision).mock.calls.map((call) => ResearchRadarDecideCommand.parse(JSON.parse(call[0] as string)));
    expect(commands.map((c) => c.payload.decision)).toEqual(['remove', 'remove', 'undo']);
    expect(commands[2]!.payload.undoes).toBe(firstRemoveId || commands[0]!.operationId);
    await flush(8);
    expect(document.querySelector('[data-testid="radar-decision"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="radar-card"]')).toHaveLength(3);
  });

  it('does not re-show a removed card when a receipt is followed by a failed refresh', async () => {
    const initial = response([paper(1), paper(2), paper(3)]);
    vi.mocked(getRadar)
      .mockResolvedValueOnce({ kind: 'ok', data: initial })
      .mockResolvedValueOnce({ kind: 'error', message: 'The server answered 500.' });
    vi.mocked(postRadarDecision).mockImplementation(async (body) => {
      const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
      return new Response(JSON.stringify(Receipt.parse({
        operationId: command.operationId,
        status: 'applied',
        path: 'Research/Radar/Decisions/2026-09.jsonl',
        commitSha: REV,
        blobSha: 'b'.repeat(40),
        effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    await render();
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { remove.click(); });
    await flush();
    expect(document.querySelectorAll('[data-testid="radar-card"]')).toHaveLength(2);
    expect(document.querySelector('[data-testid="radar-decision"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('could not be refreshed');
  });

  it('keeps multiple pending intents recoverable with Retry actions', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1), paper(2), paper(3)]) });
    vi.mocked(postRadarDecision).mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    await open();
    const firstRemove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { firstRemove.click(); });
    await flush();
    const secondRemove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { secondRemove.click(); });
    await flush();
    expect(document.querySelectorAll('[data-testid="radar-decision"]')).toHaveLength(2);
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent === 'Retry')).toHaveLength(2);
  });

  it('does not let an old-account async completion write the new account state or storage', async () => {
    const gate = deferred<Response>();
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1), paper(2), paper(3)]) });
    vi.mocked(postRadarDecision).mockImplementation(async (body) => {
      const command = ResearchRadarDecideCommand.parse(JSON.parse(body as string));
      return new Response(JSON.stringify(Receipt.parse({
        operationId: command.operationId,
        status: 'applied',
        path: 'Research/Radar/Decisions/2026-09.jsonl',
        commitSha: REV,
        blobSha: 'b'.repeat(40),
        effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: command.operationId },
      })), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-a', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    vi.mocked(postRadarDecision).mockReturnValueOnce(gate.promise);
    await act(async () => { remove.click(); });
    await flush(2);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: 'account-b', refreshKey: null, blocked: false }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    const oldReceipt = Receipt.parse({
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'applied',
      path: 'Research/Radar/Decisions/2026-09.jsonl',
      commitSha: REV,
      blobSha: 'b'.repeat(40),
      effect: { kind: 'research-radar-decided', path: 'Research/Radar/Decisions/2026-09.jsonl', decisionId: '11111111-1111-4111-8111-111111111111' },
    });
    gate.resolve(new Response(JSON.stringify(oldReceipt), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await flush(8);
    expect(document.querySelector('[data-testid="radar-decision"]')).toBeNull();
    expect(dom.window.localStorage.getItem('vault-companion:radar-pending:v1:account-b')).toBe('[]');
  });

  it('does not claim a device save when localStorage is unavailable', async () => {
    vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1), paper(2), paper(3)]) });
    vi.mocked(postRadarDecision).mockRejectedValue(new TypeError('Failed to fetch'));
    await render();
    await open();
    const remove = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => { remove.click(); });
    await flush();
    expect(document.querySelector('.radar-decision')?.textContent).toContain('could not be saved on this device');
    expect(document.querySelector('.radar-decision')?.textContent).not.toContain('The decision is saved on this device');
  });

  it('disables actions when signed out or blocked (no inert controls)', async () => {
    vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: response([paper(1)]) });
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(createElement(ResearchRadar, { accountKey: null, refreshKey: null, blocked: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    await open();
    for (const button of [...document.querySelectorAll('button')]) {
      expect(button.disabled || button.classList.contains('group-toggle')).toBe(true);
    }
    await act(async () => root.unmount());
  });
});

describe('deriveRadar Keep save status', () => {
  const keepLine = decision();
  it('pending until the desktop applied.json entry is durable', () => {
    const view = deriveRadar(response([], [keepLine]), [], new Set());
    expect(view.decisions[0]!.saveStatus).toBe('pending');
  });
  it('saved when applied.json records applied', () => {
    const view = deriveRadar(response([], [keepLine], { [OP]: { status: 'applied', at: '2026-09-30T10:00:00Z', message: '', libraryPath: 'Research/Library/Paper.md' } }), [], new Set());
    expect(view.decisions[0]!.saveStatus).toBe('saved');
  });
  it('failure when applied.json records failed', () => {
    const view = deriveRadar(response([], [keepLine], { [OP]: { status: 'failed', at: '2026-09-30T10:00:00Z', message: '', libraryPath: null } }), [], new Set());
    expect(view.decisions[0]!.saveStatus).toBe('failure');
  });
  it('saving while a local keep intent is in flight', () => {
    const intent: RadarIntent = {
      command: ResearchRadarDecideCommand.parse({
        schemaVersion: 1, operationId: OP, type: 'ResearchRadarDecide', occurredAt: '2026-09-30T10:00:00Z', baseRevision: REV,
        payload: { paperId: paperId(1), decision: 'keep', undoes: null, card: { title: 'Paper 1', source: 'https://example.com/paper-1', topic: 'rl' } },
      }),
      attempts: 0,
      status: 'pending',
      error: null,
    };
    const view = deriveRadar(response([], [keepLine]), [intent], new Set([OP]));
    expect(view.decisions[0]!.saveStatus).toBe('saving');
  });
});
