import { HealthResponse, type HealthMetric } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHealth } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import { formatHealthValue, formatMove, healthSegments, HealthPanel } from './HealthPanel.tsx';

vi.mock('../api.ts', () => ({ getHealth: vi.fn() }));

const NOW = '2026-09-30T12:00:00Z';
const series = [10, 12, null, 14, 16];

const metric = (over: Record<string, unknown> = {}): HealthMetric => ({
  key: 'steps', value: 12345, baseline: 10000, compare: 'above', series,
  ...over,
} as HealthMetric);

const health = (over: Record<string, unknown> = {}) => HealthResponse.parse({
  revision: 'a'.repeat(40), now: NOW, status: 'ok', day: '2026-09-30', staleDays: 0,
  metrics: [
    metric(),
    metric({ key: 'headphone_min', value: 45.6, baseline: 30, compare: 'below' }),
    metric({ key: 'first_move', value: 1290, baseline: 180, compare: 'usual' }),
    metric({ key: 'last_move', value: 1380, baseline: 1410, compare: 'unknown' }),
  ],
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
  lastCopies.clear();
});

const renderHealth = async (data = health()) => {
  vi.mocked(getHealth).mockResolvedValue({ kind: 'ok', data });
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(HealthPanel, { refreshKey: 0 })); });
};

const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label)!;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); }); };

describe('health formatting (HC2)', () => {
  it('formats first/last move minutes after 03:00 with the 03:00 wrap', () => {
    expect(formatMove(0)).toBe('03:00');
    expect(formatMove(180)).toBe('06:00');
    expect(formatMove(1290)).toBe('00:30');
  });

  it('formats steps with a thousands separator and headphone minutes rounded', () => {
    expect(formatHealthValue('steps', 12345)).toBe('12,345');
    expect(formatHealthValue('headphone_min', 45.6)).toBe('46');
    expect(formatHealthValue('first_move', 1290)).toBe('00:30');
  });

  it('splits sparkline series only at null entries', () => {
    expect(healthSegments(series)).toEqual([[0, 1], [3, 4]]);
    expect(healthSegments([null, 1, null])).toEqual([[1]]);
    expect(healthSegments([null, null])).toEqual([]);
  });
});

describe('Health board (HC2)', () => {
  it('shows four stat tiles with values, baselines and compare labels, and gap-aware sparklines', async () => {
    await renderHealth();
    expect(document.querySelectorAll('.health-tile')).toHaveLength(4);
    expect(text()).toContain('Steps');
    expect(text()).toContain('12,345');
    expect(text()).toContain('Usual 10,000');
    expect(text()).toContain('Above usual');
    expect(text()).toContain('Headphones (min)');
    expect(text()).toContain('46');
    expect(text()).toContain('Below usual');
    expect(text()).toContain('First move');
    expect(text()).toContain('00:30');
    expect(text()).toContain('Last move');
    expect(text()).toContain('02:00');
    expect(text()).toContain('Not enough history');
    expect(document.querySelectorAll('.health-spark')).toHaveLength(4);
    expect(document.querySelectorAll('.health-spark polyline')).toHaveLength(8);
    expect(document.querySelector('.health-spark')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows No data for a null value and no svg when the series is all null', async () => {
    await renderHealth(health({ metrics: [metric({ value: null, baseline: null, compare: 'unknown', series: [null, null, null] })] }));
    expect(text()).toContain('No data');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(1);
    expect(document.querySelectorAll('.health-spark')).toHaveLength(0);
  });

  it('labels the data day and adds old-day wording after the age threshold', async () => {
    await renderHealth(health({ day: '2026-09-30', staleDays: 0 }));
    expect(text()).toContain('Data from 30 Sept 2026');
    expect(text()).not.toContain('old');
    expect(document.querySelector('.dash-stale')).toBeNull();
  });

  it('uses the stale styling only at three or more stale days', async () => {
    await renderHealth(health({ day: '2026-09-28', staleDays: 1 }));
    expect(text()).toContain('Data from 28 Sept 2026 — 1 day old');
    expect(document.querySelector('.dash-stale')).toBeNull();

    await act(async () => root!.unmount());
    root = null;
    await renderHealth(health({ day: '2026-09-26', staleDays: 3 }));
    expect(text()).toContain('Data from 26 Sept 2026 — 3 days old');
    expect(document.querySelector('.dash-stale')).not.toBeNull();
  });

  it('reports missing and unreadable exports without tiles or sparklines', async () => {
    await renderHealth(health({ status: 'missing', metrics: [] }));
    expect(text()).toContain('No Apple Health export in the vault yet.');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(0);
    expect(document.querySelectorAll('.health-spark')).toHaveLength(0);

    await act(async () => root!.unmount());
    root = null;
    await renderHealth(health({ status: 'unreadable', metrics: [] }));
    expect(text()).toContain('The Apple Health export could not be read.');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(0);
    expect(document.querySelectorAll('.health-spark')).toHaveLength(0);
  });

  it('recovers from a failed read only when Retry health is pressed', async () => {
    vi.mocked(getHealth).mockResolvedValue({ kind: 'error', message: 'synthetic failure' });
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(HealthPanel, { refreshKey: 0 })); });
    expect(text()).toContain('Health could not be loaded.');
    expect(button('Retry health')).toBeDefined();
    expect(document.querySelectorAll('.health-tile')).toHaveLength(0);

    vi.mocked(getHealth).mockResolvedValue({ kind: 'ok', data: health() });
    await click(button('Retry health'));
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Steps');
    expect(text()).not.toContain('Health could not be loaded.');
  });
});
