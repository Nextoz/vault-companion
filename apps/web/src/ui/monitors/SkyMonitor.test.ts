// M7c3: SkyMonitor card tests. The fetches are mocked (`getSky`, `getWeather`); the clock is fixed so the computed
// Copenhagen sun times (16 Oct: up ~07:43, down ~18:10) are deterministic. Sun and moon never wait for the network.
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSky, getWeather } from '../../api.ts';
import { SkyMonitor } from './SkyMonitor.tsx';
import { skyFixture } from './sky-fixture.ts';

vi.mock('../../api.ts', () => ({ getSky: vi.fn(), getWeather: vi.fn() }));

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T14:00:00Z'));
  vi.mocked(getSky).mockReset();
  vi.mocked(getWeather).mockReset().mockResolvedValue({ kind: 'offline' });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.useRealTimers();
  dom.window.close();
});

const render = async () => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(SkyMonitor)); });
  await act(async () => {}); // let the mocked answers land in state
};
const text = () => document.getElementById('root')!.textContent ?? '';
const head = () => document.querySelector<HTMLElement>('button.monitor-head')!;
const expand = async () => { await act(async () => { head().click(); }); };

describe('SkyMonitor', () => {
  it('renders collapsed with computed sun times before any fetch answers', async () => {
    vi.mocked(getSky).mockReturnValue(new Promise(() => {}));
    vi.mocked(getWeather).mockReturnValue(new Promise(() => {}));
    await render();
    expect(document.querySelector('section.sky-monitor')).not.toBeNull();
    expect(head().textContent).toContain('Daylight & sky');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.sky-summary')?.textContent).toMatch(/^10 h \d+ min daylight · sunset 18:1\d$/);
    expect(document.querySelector('svg.sky-arc')).toBeNull();
  });

  it('expands to the arc, the walk and golden-hour rows and three tiles with the real Kp', async () => {
    vi.mocked(getSky).mockResolvedValue({ kind: 'ok', data: skyFixture() });
    await render();
    await expand();
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('svg.sky-arc')).not.toBeNull();
    expect(document.querySelectorAll('.sky-tile')).toHaveLength(3);
    expect(text()).toContain('Kp 3');
    expect(text()).toContain('aurora · low');
    expect(text()).toMatch(/\d+ %/);
    expect(text()).toContain('moon');
    expect(text()).toContain('sunset in');
    expect(text()).toContain('Golden hour');
    expect(text()).toContain('weather unavailable'); // the weather read is offline: the walk is never guessed
  });

  it('keeps sun and moon when the sky read fails or has no data, and says Kp is unavailable', async () => {
    vi.mocked(getSky).mockResolvedValue({ kind: 'offline' });
    await render();
    await expand();
    expect(text()).toContain('Kp -');
    expect(text()).toContain('unavailable');
    expect(document.querySelectorAll('.sky-tile')).toHaveLength(3);
    expect(document.querySelector('svg.sky-arc')).not.toBeNull();

    await act(async () => root!.unmount());
    vi.mocked(getSky).mockResolvedValue({ kind: 'ok', data: { status: 'unavailable', now: '2026-10-16T14:00:00.000Z', reason: 'empty', note: 'x' } });
    await render();
    await expand();
    expect(text()).toContain('Kp -');
  });

  it('names the Kp source and its fetch time only when the sky read succeeded', async () => {
    vi.mocked(getSky).mockResolvedValue({ kind: 'ok', data: skyFixture() });
    await render();
    expect(document.querySelector('.sky-updated')?.textContent).toMatch(/SunCalc · NOAA SWPC · Updated \d\d:\d\d/);
    await act(async () => root!.unmount());
    vi.mocked(getSky).mockResolvedValue({ kind: 'offline' });
    await render();
    const footer = document.querySelector('.sky-updated')?.textContent ?? '';
    expect(footer).toContain('SunCalc · NOAA SWPC');
    expect(footer).not.toContain('Updated');
  });
});
