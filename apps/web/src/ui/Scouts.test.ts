import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoutsResponse } from '@vault-companion/contracts';
import type { ScoutStatus } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScoutOutput, getScouts } from '../api.ts';
import { Scouts } from './Scouts.tsx';
import { ScoutTime } from './ScoutTime.tsx';

vi.mock('../api.ts', () => ({ getScouts: vi.fn(), getScoutOutput: vi.fn() }));

const NOW = '2026-09-27T08:50:02+02:00';
const status = (extra: Partial<ScoutStatus> & Pick<ScoutStatus, 'scoutId' | 'displayName'>): ScoutStatus => ({
  schemaVersion: 1, schedule: 'daily 07:00', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-27T07:00:00+02:00', lastSuccessAt: '2026-09-27T07:00:00+02:00',
  runStatus: 'success', sources: { configured: 3, successful: 3 }, aiHealth: 'healthy', findings: 4, added: 2,
  errors: 0, lastError: null, latestOutput: null, history: [], ...extra,
});
const ok = (file: string, s: ScoutStatus) => ({ state: 'ok' as const, file, status: s });
const healthy = ok('learning.json', status({ scoutId: 'learning', displayName: 'Learning opportunities', latestOutput: 'Discoveries/Learning.md' }));
const failed = ok('city-events.json', status({
  scoutId: 'city-events', displayName: 'City events', runStatus: 'failed', lastSuccessAt: null, findings: null,
  sources: null, aiHealth: null, lastError: 'runner could not start', lastAttemptAt: '2026-09-27T06:50:02+02:00',
  history: [{ at: '2026-09-27T06:50:02+02:00', status: 'failed', findings: null }],
}));
const degraded = ok('research.json', status({ scoutId: 'deep-research', displayName: 'Deep research', runStatus: 'degraded', findings: 5 }));
const unreadable = { state: 'unreadable' as const, file: 'unreadable.json' };

const response = (scouts: unknown[]) => ScoutsResponse.parse({ revision: 'a'.repeat(40), now: NOW, scouts });
const render = async (scouts: unknown[], onOpen: () => void = () => {}) => {
  vi.mocked(getScouts).mockResolvedValue({ kind: 'ok', data: response(scouts) });
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(createElement(Scouts, { page: true, onOpen, refreshKey: 0 })); });
  return root;
};
const row = (part: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.scout-row')].find((button) => (button.getAttribute('aria-label') ?? '').includes(part))!;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };

it('primary time text is friendly, with exact Copenhagen date and offset only in the title', () => {
  for (const [at, title] of [
    ['2026-10-25T00:00:00Z', '25 Oct 2026 02:00 (GMT+2, Europe/Copenhagen)'],
    ['2026-10-25T01:00:00Z', '25 Oct 2026 02:00 (GMT+1, Europe/Copenhagen)'],
  ]) {
    const html = renderToStaticMarkup(createElement(ScoutTime, { at: at!, now: '2026-10-25T03:00:00Z' }));
    const time = new JSDOM(html).window.document.querySelector('time')!;
    expect(time.textContent).toBe('Today 02:00');
    expect(time.textContent).not.toContain(at);
    expect(time.title).toBe(title);
  }
});

describe('compact scout health list', () => {
  let dom: JSDOM;
  let root: Root | null = null;
  beforeEach(() => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
    Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
    vi.mocked(getScoutOutput).mockResolvedValue({ kind: 'offline' });
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    dom.window.close();
  });

  it('summarises health and renders one compact, labelled row per scout', async () => {
    root = await render([failed, healthy, degraded, unreadable]);
    expect(document.querySelector('[data-testid="scout-summary"]')!.textContent).toBe('1 ok · 3 with problems');
    const list = document.querySelector('ul.scout-list')!;
    expect(list.getAttribute('aria-label')).toBe('Scout health');
    expect(list.querySelectorAll('.scout-row')).toHaveLength(4);
    expect(list.querySelectorAll('.scout-dot')).toHaveLength(4);
    expect(row('City events').textContent).toContain('Failed');
    expect(row('City events').textContent).toContain('— findings');
    expect(row('City events').textContent).toContain('Last run Today 06:50');
    expect(row('Learning opportunities').textContent).toContain('4 findings');
    expect(row('Deep research').textContent).toContain('Ran with problems');
    // Sparkline and source/AI chips belong to the detail view, not the list.
    expect(list.querySelector('.scout-sparkline')).toBeNull();
    expect(list.querySelector('.scout-chips')).toBeNull();
  });

  it('keeps a malformed record as an honest disabled fallback', async () => {
    root = await render([healthy, unreadable]);
    const broken = row('unreadable.json');
    expect(broken.textContent).toContain('No status yet');
    expect(broken.disabled).toBe(true);
  });

  it('opens a detail with the sparkline, source/AI chips, findings loading, and a working Back', async () => {
    let release!: () => void;
    vi.mocked(getScoutOutput).mockImplementation(() => new Promise((resolve) => { release = () => resolve({ kind: 'offline' }); }));
    root = await render([healthy, failed]);
    await click(row('Learning opportunities'));
    const detail = document.querySelector('.scout-detail')!;
    expect(detail.querySelectorAll('.scout-sparkline')).toHaveLength(1);
    expect(detail.querySelector('.scout-chips')!.textContent).toBe('Sources 3/3AI healthy');
    expect(detail.querySelector('[role="status"]')!.textContent).toBe('Loading findings…');
    expect(getScoutOutput).toHaveBeenCalledWith('learning');
    expect(document.querySelector('.scout-list')).toBeNull();
    await click(detail.querySelector('.scout-back')!);
    expect(document.querySelector('.scout-list')).not.toBeNull();
    expect(document.querySelector('.scout-detail')).toBeNull();
    // Insights previews must not restart when the detail view opens and closes.
    expect(vi.mocked(getScoutOutput).mock.calls.filter(([id]) => id === 'learning')).toHaveLength(2);
    await act(async () => release());
  });

  it('puts the findings/results section below the health rows', async () => {
    root = await render([healthy, failed]);
    const list = document.querySelector('.scout-list')!;
    const insights = document.querySelector('.insights')!;
    expect(list.compareDocumentPosition(insights) & 4).toBeTruthy();
  });

  it('hides the calendar-sync tracker while healthy or degraded', async () => {
    const triage = ok('triage.json', status({ scoutId: 'triage-applier', displayName: 'Triage applier' }));
    root = await render([healthy, triage]);
    expect(document.querySelector('.scout-triage-attention')).toBeNull();
    expect(document.body.textContent).not.toContain('Calendar sync');
    expect(document.body.textContent).not.toContain('Triage applier');
    expect(document.querySelectorAll('.scout-row')).toHaveLength(1);
    await act(async () => root!.unmount());
    root = await render([healthy, ok('triage.json', status({ scoutId: 'triage-applier', displayName: 'Triage applier', runStatus: 'degraded' }))]);
    expect(document.querySelector('.scout-triage-attention')).toBeNull();
  });

  it('shows the tracker attention line on Failed and Stale and opens its error detail', async () => {
    const triageFailed = ok('triage.json', status({
      scoutId: 'triage-applier', displayName: 'Triage applier', runStatus: 'failed', lastSuccessAt: null,
      findings: null, lastError: 'calendar sync could not reach the vault',
    }));
    root = await render([healthy, triageFailed]);
    const attention = document.querySelector('.scout-triage-attention') as HTMLButtonElement;
    expect(attention.textContent).toContain('Calendar sync failed');
    expect(document.querySelector('[data-testid="scout-summary"]')!.textContent).toBe('1 ok · 1 with problems');
    expect(document.querySelector('.scout-list')!.textContent).not.toContain('Triage applier');
    expect(document.querySelector('.insights')!.textContent).not.toContain('Triage applier');
    await click(attention);
    expect(document.querySelector('.scout-detail')!.textContent).toContain('calendar sync could not reach the vault');
    await act(async () => root!.unmount());
    root = await render([healthy, ok('triage.json', status({ scoutId: 'triage-applier', displayName: 'Triage applier', lastAttemptAt: '2026-09-20T07:00:00+02:00' }))]);
    expect(document.querySelector('.scout-triage-attention')!.textContent).toContain('Calendar sync stale');
  });
});
