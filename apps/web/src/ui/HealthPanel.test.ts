import { HealthHistoryResponse, HealthResponse, RingDayResponse, type HealthMetric, type RingDailyRow } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHealth, getHealthHistory, getRingDay } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import { formatHealthValue, formatMove, healthSegments, HealthPanel } from './HealthPanel.tsx';

vi.mock('../api.ts', () => ({ getHealth: vi.fn(), getHealthHistory: vi.fn(), getRingDay: vi.fn() }));
const sheetChunk = vi.hoisted(() => ({ loaded: false }));
vi.mock('./RingDaySheet.tsx', async (original) => {
  sheetChunk.loaded = true;
  return original();
});

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

const night: RingDailyRow = {
  date: '2026-09-29', sleepStart: null, sleepEnd: null, lightMin: 334, deepMin: 98, awakeMin: null,
  restingHr: 54, avgHr: null, minSpo2: null, avgSpo2: null, hrvSdnnMs: 41, bodyTempC: 36.2,
  hrN: 1, spo2N: 0, hrvN: 1, tempN: 1, sleepN: 2,
};
const vitals = (over: Record<string, unknown> = {}) => ({ status: 'ok', row: night, daySlots: 96, staleDays: 0, ...over });
const mockRingDay = (date: string) => vi.mocked(getRingDay).mockResolvedValue({ kind: 'ok', data: RingDayResponse.parse({
  revision: 'a'.repeat(40), now: NOW, today: date, date, status: 'missing',
  dayStart: `${date}T00:00:00+02:00`, dayEnd: `${date}T00:00:00+02:00`, daySlots: 96,
  slots: [], night: null, prevDate: null, nextDate: null,
}) });

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

  it('opens the history view lazily only when the History toggle is pressed', async () => {
    vi.mocked(getHealthHistory).mockResolvedValue({
      kind: 'ok',
      data: HealthHistoryResponse.parse({
        revision: 'a'.repeat(40), now: NOW, status: 'ok',
        days: [{ date: '2026-09-29', steps: 5000, headphone_min: 40, first_move: 300, last_move: 1300 }],
      }),
    });
    await renderHealth();
    expect(getHealthHistory).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Health history"]')).toBeNull();
    expect(button('History').getAttribute('aria-expanded')).toBe('false');

    await click(button('History'));
    expect(getHealthHistory).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[aria-label="Health history"]')).not.toBeNull();
    expect(button('History').getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('Range median');
  });
});

describe('Health Ring card (HC4-d2)', () => {
  it('shows four night tiles and leaves v1 metrics, layout and history unchanged', async () => {
    await renderHealth();
    const v1 = document.querySelector('.health-tiles')!.outerHTML;
    await act(async () => root!.unmount()); root = null;
    await renderHealth(health({ vitals: vitals() }));
    expect(document.querySelector('.health-tiles')!.outerHTML).toBe(v1);
    expect(document.querySelector('.dash-health > .health-tiles')).not.toBeNull();
    expect(button('History').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.ring-label')?.textContent).toBe('Ring · 2026-09-29');
    expect([...document.querySelectorAll('.ring-summary-tiles > span')].map(el => el.textContent))
      .toEqual(['7 h 12asleep', '54resting HR', '41 msHRV (unverified)', '36.2°temp (day avg)']);
    expect(getRingDay).not.toHaveBeenCalled();
    expect(sheetChunk.loaded).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    vi.mocked(getHealthHistory).mockResolvedValue({ kind: 'ok', data: HealthHistoryResponse.parse({
      revision: 'a'.repeat(40), now: NOW, status: 'ok', days: [],
    }) });
    await click(button('History'));
    expect(getHealthHistory).toHaveBeenCalledTimes(1);
    expect(button('History').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[aria-label="Health history"]')).not.toBeNull();
  });

  it.each(['lightMin', 'deepMin'])('uses em dashes for null readings, including %s', async key => {
    await renderHealth(health({ vitals: vitals({ row: { ...night, [key]: null, restingHr: null, hrvSdnnMs: null, bodyTempC: null } }) }));
    expect([...document.querySelectorAll('.ring-summary-tiles b')].map(el => el.textContent)).toEqual(['—', '—', '—', '—']);
    expect(document.querySelector('.ring-summary')?.textContent).toContain('HRV (unverified)');
  });

  it.each([0, 1, 2])('shows a plain age note only after one stale day (%s)', async staleDays => {
    await renderHealth(health({ vitals: vitals({ staleDays }) }));
    const note = document.querySelector('.ring-summary .ring-note');
    if (staleDays > 1) {
      expect(note?.textContent).toBe('2 days old');
      expect(note?.className).toBe('ring-note');
    } else expect(note).toBeNull();
  });

  it('shows no Ring section for an old cached response without vitals', async () => {
    await renderHealth();
    expect(document.querySelector('[aria-label="Ring"]')).toBeNull();
    expect(text()).not.toContain('Ring');
  });

  it('shows unreadable data as a plain line without a button', async () => {
    await renderHealth(health({ vitals: vitals({ status: 'unreadable', row: null }) }));
    const section = document.querySelector('[aria-label="Ring"]')!;
    expect(section.textContent).toBe('Ring data could not be read');
    expect(section.querySelector('button')).toBeNull();
    await click(section);
    expect(getRingDay).not.toHaveBeenCalled();
  });

  it.each([
    ['ok', '2026-09-29', '2026-09-30T23:30:00Z'],
    ['missing', '2026-10-01', '2026-09-30T23:30:00Z'],
    ['missing', '2026-10-30', '2026-10-29T23:30:00Z'],
  ])('opens %s lazily on %s and restores focus on close', async (status, date, now) => {
    mockRingDay(date);
    await renderHealth(health({ now, vitals: vitals({ status, row: status === 'ok' ? night : null }) }));
    const row = document.querySelector<HTMLButtonElement>('.ring-summary-row')!;
    if (status === 'missing') expect(row.textContent).toBe('No ring data yet');
    expect(getRingDay).not.toHaveBeenCalled();
    row.focus();
    await click(row);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(sheetChunk.loaded).toBe(true);
    // `loaded` flips when the import starts; the real sheet module (and its registry) can take seconds on a cold
    // Windows CI runner, past waitFor's 1 s default (flaky on main twice): wait for the sheet's read, generously.
    await act(async () => { await vi.waitFor(() => expect(getRingDay).toHaveBeenCalledWith(date), { timeout: 15_000 }); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
    await click(close);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(row);
  }, 20_000);

  it('contains a rejected sheet import and keeps the Health panel usable', async () => {
    vi.resetModules();
    vi.doMock('../api.ts', () => ({ getHealth, getHealthHistory, getRingDay }));
    vi.doMock('./RingDaySheet.tsx', () => { throw new Error('synthetic chunk failure'); });
    const { HealthPanel: IsolatedPanel } = await import('./HealthPanel.tsx');
    vi.mocked(getHealth).mockResolvedValue({ kind: 'ok', data: health({ vitals: vitals() }) });
    const caught = vi.fn();
    root = createRoot(document.getElementById('root')!, { onCaughtError: caught });
    await act(async () => root!.render(createElement(IsolatedPanel, { refreshKey: 0 })));
    const row = document.querySelector<HTMLButtonElement>('.ring-summary-row')!;
    await click(row);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(caught).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Ring day could not be opened. Reload to try again.');
    expect(document.querySelectorAll('.health-tile')).toHaveLength(4);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(row.disabled).toBe(true);
    await click(button('History'));
    expect(button('History').getAttribute('aria-expanded')).toBe('true');
  });
});
