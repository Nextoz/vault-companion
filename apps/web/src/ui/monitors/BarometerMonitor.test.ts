// BarometerMonitor card tests. The fetch is mocked (`getBarometer`); every string asserted is the card's real output
// for the shared barometerFixture (the same data the e2e barometer spec serves through MockApi).
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BarometerResponse } from '@vault-companion/contracts';
import { getBarometer, type Fetched } from '../../api.ts';
import { BarometerMonitor } from './BarometerMonitor.tsx';
import { barometerFixture } from './barometer-fixture.ts';

vi.mock('../../api.ts', () => ({ getBarometer: vi.fn() }));

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.mocked(getBarometer).mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
});

const answer = (data: BarometerResponse): Fetched<BarometerResponse> => ({ kind: 'ok', data });
const render = async () => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(BarometerMonitor)); });
  await act(async () => {}); // let the answer land in state
};
const text = () => document.getElementById('root')!.textContent ?? '';
const q = (selector: string) => document.querySelector(selector);
const open = async () => { await act(async () => { (q('.monitor-head') as HTMLElement).click(); }); };

describe('BarometerMonitor', () => {
  it('is collapsed by default with the one-line summary and no dial', async () => {
    vi.mocked(getBarometer).mockResolvedValue(answer(barometerFixture()));
    await render();
    expect(q('.baro-summary')!.textContent).toBe('1020.2 hPa · ↑ 1.3 in 3 h · Fair');
    expect(q('.baro-dial')).toBeNull();
  });

  it('opens to the dial: needle, 3 h hand, five zones, the value and a labelled footer', async () => {
    vi.mocked(getBarometer).mockResolvedValue(answer(barometerFixture()));
    await render();
    await open();
    expect(q('.baro-dial')!.getAttribute('aria-label')).toBe('Barometer 1020.2 hPa, rising 1.3 hPa in 3 hours, Fair');
    expect(document.querySelectorAll('.baro-zone')).toHaveLength(5);
    expect(document.querySelectorAll('.baro-needle')).toHaveLength(1);
    expect(document.querySelectorAll('.baro-set')).toHaveLength(1);
    expect(q('.baro-value')!.textContent).toBe('1020.2');
    expect(q('.baro-footer')!.textContent).toContain('DMI measured · Trianglen · 13:50');
  });

  it('draws no 3 h hand and no change clause when the history is missing', async () => {
    vi.mocked(getBarometer).mockResolvedValue(answer(barometerFixture({ hPaThreeHoursAgo: null, changeHpa: null, trend: null })));
    await render();
    expect(q('.baro-summary')!.textContent).toBe('1020.2 hPa · Fair');
    await open();
    expect(document.querySelectorAll('.baro-set')).toHaveLength(0);
  });

  it('labels a model reading as a model, never as measured', async () => {
    vi.mocked(getBarometer).mockResolvedValue(answer(barometerFixture({ source: 'model' })));
    await render();
    expect(q('.baro-summary')!.textContent).toContain('· model');
    expect(q('.baro-footer')!.textContent).toContain('Model (Open-Meteo)');
    expect(text()).not.toContain('DMI measured');
  });

  it('shows the provider note and no number when unavailable, and a Retry when the read fails', async () => {
    vi.mocked(getBarometer).mockResolvedValue(answer({ status: 'unavailable', now: '2026-09-30T12:00:00.000Z', reason: 'empty', note: 'No recent pressure reading is available.' }));
    await render();
    expect(text()).toContain('No recent pressure reading is available.');
    expect(q('.baro-summary')).toBeNull();
    expect(text()).not.toMatch(/\d hPa/);
    await act(async () => root!.unmount());
    vi.mocked(getBarometer).mockResolvedValueOnce({ kind: 'error', message: 'down' }).mockResolvedValueOnce(answer(barometerFixture()));
    await render();
    expect(text()).toContain('Barometer could not be loaded. No value is shown.');
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Retry') as HTMLElement;
    await act(async () => { retry.click(); });
    await act(async () => {});
    expect(q('.baro-summary')!.textContent).toBe('1020.2 hPa · ↑ 1.3 in 3 h · Fair');
  });
});
