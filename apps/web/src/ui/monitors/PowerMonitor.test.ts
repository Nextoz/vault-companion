// M4c3: PowerMonitor card tests. The fetch is mocked (`getPower`); every string and count asserted here is the
// card's real output for the shared powerFixture — the same data the e2e power-monitor spec serves through MockApi.
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPower } from '../../api.ts';
import { PowerMonitor } from './PowerMonitor.tsx';
import { powerFixture } from './power-fixture.ts';

vi.mock('../../api.ts', () => ({ getPower: vi.fn() }));

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.mocked(getPower).mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
});

const render = async () => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(PowerMonitor)); });
  await act(async () => {}); // let getPower's answer land in state
};

const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
const click = async (label: string) => { await act(async () => { (button(label) as HTMLElement).click(); }); };
// The card region, named "Power (DK2)" by the heading its aria-labelledby points at.
const card = () => {
  const section = document.querySelector<HTMLElement>('section.power-monitor');
  expect(section).not.toBeNull();
  expect(document.getElementById(section!.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Power (DK2)');
  return section!;
};

describe('PowerMonitor', () => {
  it('renders the ok card collapsed: one summary line, no chart, head button not expanded', async () => {
    vi.mocked(getPower).mockResolvedValue({ kind: 'ok', data: powerFixture() });
    await render();
    card();
    expect(document.querySelector('.power-summary')!.textContent).toBe('Now 1.96 kr · cheapest 12-15 0.94 kr');
    expect(document.querySelector('svg.power-chart')).toBeNull();
    expect(button('Power (DK2)').getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to today’s chart (24 bars, 1 now, 3 cheap) and the tabs switch day details', async () => {
    vi.mocked(getPower).mockResolvedValue({ kind: 'ok', data: powerFixture() });
    await render();
    await click('Power (DK2)');
    expect(button('Power (DK2)').getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.power-bar')).toHaveLength(24);
    expect(document.querySelectorAll('.power-bar-now')).toHaveLength(1);
    expect(document.querySelectorAll('.power-bar-cheap')).toHaveLength(3);
    expect(text()).toContain('CO₂ intensity: 39 g/kWh now');
    await click('Tomorrow');
    expect(text()).toContain('Cheapest 3 h · 12-15 · 0.94 kr');
    expect(document.querySelectorAll('.power-bar')).toHaveLength(24);
  });

  it('shows the not-published note instead of a chart on the Tomorrow tab before publication', async () => {
    vi.mocked(getPower).mockResolvedValue({ kind: 'ok', data: powerFixture({ tomorrowPublished: false }) });
    await render();
    await click('Power (DK2)');
    await click('Tomorrow');
    expect(text()).toContain('not published yet');
    expect(document.querySelector('svg.power-chart')).toBeNull();
  });

  it('shows the failure note and fetches a second time when Retry is clicked', async () => {
    vi.mocked(getPower).mockResolvedValue({ kind: 'offline' });
    await render();
    expect(document.querySelector('.power-failure .dash-note')!.textContent).toBe('Power prices could not be loaded. No values are shown.');
    expect(vi.mocked(getPower)).toHaveBeenCalledTimes(1);
    await click('Retry');
    expect(vi.mocked(getPower)).toHaveBeenCalledTimes(2);
  });

  it('shows the provider note and no tabs when no DK2 prices are published for today', async () => {
    vi.mocked(getPower).mockResolvedValue({
      kind: 'ok',
      data: { status: 'unavailable', now: '2026-10-16T17:15:00.000Z', reason: 'empty', note: 'No DK2 spot prices are published for today.' },
    });
    await render();
    card();
    expect(text()).toContain('No DK2 spot prices are published for today.');
    expect(document.querySelector('.segmented')).toBeNull();
  });
});
