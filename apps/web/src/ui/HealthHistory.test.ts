import { HealthHistoryResponse, type HealthHistoryDay } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHealthHistory } from '../api.ts';
import { HealthHistory, sliceHistory } from './HealthHistory.tsx';

vi.mock('../api.ts', () => ({ getHealth: vi.fn(), getHealthHistory: vi.fn() }));

const NOW = Date.parse('2026-09-30T12:00:00Z'); // Copenhagen: yesterday is 2026-09-29.

const mk = (date: string, over: Partial<HealthHistoryDay> = {}): HealthHistoryDay => ({
  date, steps: 1000, headphone_min: 30, first_move: 300, last_move: 1300, ...over,
});

const history = (over: Record<string, unknown> = {}) => HealthHistoryResponse.parse({
  revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'ok',
  days: [mk('2026-09-27'), mk('2026-09-28', { steps: null }), mk('2026-09-29', { steps: 3000 })],
  ...over,
});

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
  vi.clearAllMocks();
});

async function render(data = history(), result: Awaited<ReturnType<typeof getHealthHistory>> = { kind: 'ok', data }) {
  vi.mocked(getHealthHistory).mockResolvedValue(result);
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(HealthHistory)); });
}

const text = () => document.getElementById('root')!.textContent ?? '';
const buttons = (within: ParentNode = document) => [...within.querySelectorAll('button')];
const button = (label: string, within: ParentNode = document) => buttons(within).find((element) => element.textContent?.trim() === label)!;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };

describe('history range slicing (HC3b)', () => {
  const days = [mk('2026-08-30'), mk('2026-08-31'), mk('2026-09-01'), mk('2026-09-15'), mk('2026-09-29'), mk('2026-09-30'), mk('2026-10-05')];

  it('takes 30 calendar days ending yesterday, inclusive, and drops today/future days', () => {
    expect(sliceHistory(days, '30d', NOW).map((day) => day.date))
      .toEqual(['2026-08-31', '2026-09-01', '2026-09-15', '2026-09-29']);
  });

  it('widens to 1 y, and All starts at the first row (future days still excluded)', () => {
    expect(sliceHistory(days, '1y', NOW).map((day) => day.date))
      .toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-15', '2026-09-29']);
    const all = sliceHistory(days, 'all', NOW);
    expect(all[0]!.date).toBe('2026-08-30');
    expect(all.map((day) => day.date)).not.toContain('2026-10-05');
  });
});

describe('HealthHistory view (HC3b)', () => {
  it('shows a formatted range median per metric and gap-aware lines', async () => {
    await render();
    expect(document.querySelectorAll('.health-tile')).toHaveLength(4);
    expect(text()).toContain('Range median');
    expect(text()).toContain('2,000'); // steps median of 1000 and 3000, the null dropped
    expect(text()).toContain('Steps');
    expect(text()).toContain('Headphones (min)');
    expect(text()).toContain('First move');
    expect(text()).toContain('Last move');
    expect(document.querySelectorAll('[aria-label="History range"] button')).toHaveLength(4);
    // Steps is [1000, null, 3000]: two one-point segments, so no polyline; the other three are unbroken.
    expect(document.querySelectorAll('.health-history-line')).toHaveLength(4);
    expect(document.querySelectorAll('.health-history-line polyline')).toHaveLength(3);
  });

  it('says No data in this range when the window holds no values', async () => {
    await render(history({ days: [mk('2026-09-29', { steps: null, headphone_min: null, first_move: null, last_move: null })] }));
    expect(text()).toContain('No data in this range.');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(0);
  });

  it('reports missing and unreadable like the card', async () => {
    await render(history({ status: 'missing', days: [] }));
    expect(text()).toContain('No Apple Health export in the vault yet.');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(0);

    await act(async () => root!.unmount());
    root = null;
    await render(history({ status: 'unreadable', days: [] }));
    expect(text()).toContain('The Apple Health export could not be read.');
  });

  it('re-slices to 1 y and All client-side without another fetch', async () => {
    await render();
    const group = document.querySelector('[aria-label="History range"]')!;
    expect(button('30 d', group).getAttribute('aria-pressed')).toBe('true');
    await click(button('1 y', group));
    expect(button('1 y', group).getAttribute('aria-pressed')).toBe('true');
    expect(button('30 d', group).getAttribute('aria-pressed')).toBe('false');
    await click(button('All', group));
    expect(button('All', group).getAttribute('aria-pressed')).toBe('true');
    expect(getHealthHistory).toHaveBeenCalledTimes(1);
  });

  it('offers Retry history after a failed read', async () => {
    vi.mocked(getHealthHistory).mockResolvedValue({ kind: 'error', message: 'synthetic failure' });
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(HealthHistory)); });
    expect(text()).toContain('History could not be loaded.');
    expect(button('Retry history')).toBeDefined();

    vi.mocked(getHealthHistory).mockResolvedValue({ kind: 'ok', data: history() });
    await click(button('Retry history'));
    expect(getHealthHistory).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Range median');
  });
});
