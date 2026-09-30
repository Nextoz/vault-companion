import { DashboardResponse, MarketTickerResponse, type DashboardCard } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboard, getMarketTicker, type Fetched } from '../api.ts';
import { Dashboard, MARKET_STALE_MS, mergeTicker, seriesSegments } from './Dashboard.tsx';

vi.mock('../api.ts', () => ({ getDashboard: vi.fn(), getMarketTicker: vi.fn() }));

const NOW = '2026-09-30T12:00:00Z';
const TICKER = { base: 'BTC' as const, quote: 'USD' as const, provider: 'coinbase' as const, price: 60123.45, providerTime: NOW };
const point = (i: number, base = 60000) => ({ time: new Date(Date.parse(NOW) - (6 - i) * 3_600_000).toISOString(), open: base, high: base + 100, low: base - 100, close: base + i });
const market = (over: Record<string, unknown> = {}): DashboardCard => ({
  id: 'market', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, ticker: TICKER,
  series: { range: '1W', granularitySeconds: 3_600, points: [point(0), point(1), point(2)], missingIntervals: 0 },
  ...over,
} as DashboardCard);
const overviewCards: DashboardCard[] = [
  { id: 'ai-usage', status: 'not-configured', title: 'AI usage', provenance: 'Not configured', observedAt: null, fetchedAt: null, note: 'No approved usage source is connected yet.', drillthrough: null },
  { id: 'health', status: 'not-configured', title: 'Health', provenance: 'Not configured', observedAt: null, fetchedAt: null, note: 'No approved health source is connected yet.', drillthrough: null },
];
const response = (cards: DashboardCard[] = [market(), ...overviewCards]) => DashboardResponse.parse({ now: NOW, cards });
const ok = (cards?: DashboardCard[]) => ({ kind: 'ok' as const, data: response(cards) });
const tickerOk = () => ({ kind: 'ok' as const, data: MarketTickerResponse.parse({ status: 'ok', now: NOW, ticker: TICKER, fetchedAt: NOW }) });

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.mocked(getMarketTicker).mockResolvedValue({ kind: 'offline' });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const render = async (cards?: DashboardCard[], onDrillthrough?: (view: string) => void) => {
  vi.mocked(getDashboard).mockResolvedValue(ok(cards));
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0, onDrillthrough })); });
  return root;
};
const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

describe('BTC/USD market card (DASH1)', () => {
  it('shows the current value, provider market time and fetched time, plus the series', async () => {
    await render();
    expect(text()).toContain('$60,123.45');
    expect(text()).toContain('Market time');
    expect(text()).toContain('fetched');
    expect(text()).toContain('12:00 UTC');
    expect(button('1W').getAttribute('aria-pressed')).toBe('true');
    expect(button('1M').getAttribute('aria-pressed')).toBe('false');
    const svg = document.querySelector('.dash-svg')!;
    expect(svg.getAttribute('aria-label')).toContain('1 week');
    expect(svg.getAttribute('aria-label')).toContain('3 points');
  });

  it('keeps overview cards honest: no fake numbers for a source that is not connected', async () => {
    await render();
    expect(text()).toContain('AI usage');
    expect(text()).toContain('Health');
    expect(text()).toContain('Not configured');
    expect(text()).toContain('No approved usage source is connected yet.');
    const overviewText = [...document.querySelectorAll('.dash-card')].filter((card) => !card.classList.contains('dash-market')).map((card) => card.textContent ?? '').join(' ');
    expect(overviewText).not.toMatch(/\$\d/);
    expect(overviewText).not.toMatch(/\d+ ?(quota|spend|reset)/i);
  });

  it('renders every provider gap as a gap, never as a joined line', async () => {
    const gapped = market({ series: { range: '1W', granularitySeconds: 3_600, points: [point(0), point(1), point(4)], missingIntervals: 2 } });
    await render([gapped, ...overviewCards]);
    expect(document.querySelectorAll('.dash-svg polyline')).toHaveLength(1);
    expect(document.querySelectorAll('.dash-svg .dash-dot')).toHaveLength(1);
    expect(text()).toContain('2 intervals missing');
  });

  it('renders a market failure as unavailable without erasing the other cards', async () => {
    const down: DashboardCard = { id: 'market', status: 'unavailable', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)', observedAt: null, fetchedAt: null, note: 'The market provider is unavailable right now.', drillthrough: null, reason: 'provider-error' };
    await render([down, ...overviewCards]);
    expect(text()).toContain('Unavailable');
    expect(text()).toContain('The market provider is unavailable right now.');
    expect(text()).toContain('AI usage');
  });
});

describe('range and freshness (DASH1)', () => {
  it('recovers an initial failure only when the explicit dashboard retry is requested', async () => {
    vi.useFakeTimers();
    vi.mocked(getDashboard).mockResolvedValue({ kind: 'error', message: 'synthetic failure' });
    vi.mocked(getMarketTicker).mockResolvedValue(tickerOk());
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0 })); });
    expect(text()).toContain('The dashboard could not be loaded.');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(button('Retry dashboard')).toBeDefined();
    vi.mocked(getDashboard).mockResolvedValue(ok());
    await click(button('Retry dashboard'));
    expect(getDashboard).toHaveBeenCalledTimes(2);
    expect(text()).toContain('$60,123.45');
    expect(document.querySelector('.dash-svg')).not.toBeNull();
    expect(text()).not.toContain('The dashboard could not be loaded.');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });

  it('retries unavailable history after a successful ticker poll', async () => {
    vi.useFakeTimers();
    const down: DashboardCard = { id: 'market', status: 'unavailable', title: 'BTC / USD', provenance: 'Synthetic provider', observedAt: null, fetchedAt: null, note: 'Unavailable', drillthrough: null, reason: 'provider-error' };
    await render([down, ...overviewCards]);
    vi.mocked(getMarketTicker).mockResolvedValue(tickerOk());
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(button('Retry dashboard')).toBeDefined();
    vi.mocked(getDashboard).mockResolvedValue(ok());
    await click(button('Retry dashboard'));
    expect(document.querySelector('.dash-svg')).not.toBeNull();
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });

  it('asks for the new range and ignores a late reply from the range the user left', async () => {
    const oneWeek = deferred<Fetched<DashboardResponse>>();
    vi.mocked(getDashboard).mockImplementation((range) => (range === '1W' ? oneWeek.promise : Promise.resolve(ok([market({ series: { range: '1M', granularitySeconds: 21_600, points: [point(0), point(1)], missingIntervals: 0 } }), ...overviewCards]))));
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0 })); });
    await click(button('1M'));
    await flush();
    expect(document.querySelector('.dash-svg')!.getAttribute('aria-label')).toContain('1 month');
    await act(async () => { oneWeek.resolve(ok()); await Promise.resolve(); });
    expect(document.querySelector('.dash-svg')!.getAttribute('aria-label')).toContain('1 month'); // the stale 1W reply changed nothing
    expect(document.querySelector('.dash-svg')!.getAttribute('aria-label')).toContain('2 points');
  });

  it('keeps the last series but marks it stale when a refresh fails', async () => {
    await render();
    vi.mocked(getDashboard).mockResolvedValue({ kind: 'error', message: 'boom' });
    await click(button('1M'));
    await flush();
    expect(text()).toContain('Stale');
    expect(text()).toContain('$60,123.45'); // the known value is still shown, labelled
    expect(text()).toContain('AI usage');
  });

  it('marks data stale once it is older than the freshness window', async () => {
    const old = market({ fetchedAt: new Date(Date.parse(NOW) - MARKET_STALE_MS - 1).toISOString() });
    await render([old, ...overviewCards]);
    expect(text()).toContain('Stale');
    expect(text()).toContain('not fresh');
  });
});

describe('ticker polling guard (DASH1)', () => {
  it('refreshes only the ticker every 60 s while visible, and stays quiet while hidden or offline', async () => {
    vi.useFakeTimers();
    vi.mocked(getMarketTicker).mockResolvedValue(tickerOk());
    await render();
    expect(vi.mocked(getDashboard)).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(getMarketTicker)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getDashboard)).toHaveBeenCalledTimes(1); // history is never polled every minute
    // Hidden: no poll.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(getMarketTicker)).toHaveBeenCalledTimes(1);
    // Visible again but offline: still no poll.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(getMarketTicker)).toHaveBeenCalledTimes(1);
  });
});

describe('inspection and account edges (DASH1)', () => {
  it('maps touch to padded plot coordinates at scaled left and right edges', async () => {
    await render([market({ series: { range: '1W', granularitySeconds: 3600, points: Array.from({ length: 167 }, (_, i) => point(i)), missingIntervals: 0 } }), ...overviewCards]);
    const chart = document.querySelector<SVGSVGElement>('.dash-svg')!;
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 20, width: 160, height: 60, right: 200, bottom: 80, x: 40, y: 20, toJSON: () => ({}) });
    const touch = async (clientX: number) => {
      await act(async () => { chart.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX })); });
    };
    await touch(41); // inside the nonzero left padding: old full-width mapping picks point 1
    expect(document.querySelector('.dash-slider')!.getAttribute('value')).toBe('0');
    expect(document.querySelector('.dash-readout')!.textContent).toContain('$60,000.00');
    await touch(197); // plotted final point at viewBox x=314, not the bounding-box edge
    expect(document.querySelector('.dash-slider')!.getAttribute('value')).toBe('166');
    await touch(240);
    expect(document.querySelector('.dash-slider')!.getAttribute('value')).toBe('166');
    await touch(20);
    expect(document.querySelector('.dash-slider')!.getAttribute('value')).toBe('0');
  });

  it('lets the keyboard move the selected point and reads it out', async () => {
    await render();
    const slider = document.querySelector<HTMLInputElement>('.dash-slider')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(slider, '0');
      slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      slider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    expect(document.querySelector('.dash-readout')!.textContent).toContain('$60,000.00');
    expect(document.querySelector('.dash-cursor')).not.toBeNull();
  });

  it('ignores a reply that lands after unmount (no old-account content)', async () => {
    const late = deferred<Fetched<DashboardResponse>>();
    vi.mocked(getDashboard).mockReturnValue(late.promise);
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0 })); });
    await act(async () => { root!.unmount(); });
    root = null;
    await act(async () => { late.resolve(ok()); await Promise.resolve(); });
    expect(document.getElementById('root')!.textContent).toBe('');
  });

  it('exposes the drillthrough seam a later detail view can use', async () => {
    const onDrillthrough = vi.fn();
    const card = { ...overviewCards[0]!, drillthrough: { label: 'Usage detail', view: 'usage' } } as DashboardCard;
    await render([market(), card, overviewCards[1]!], onDrillthrough);
    await click(button('Usage detail'));
    expect(onDrillthrough).toHaveBeenCalledWith('usage');
  });
});

describe('pure helpers (DASH1)', () => {
  it('splits segments only where a bucket is missing', () => {
    const series = { range: '1W' as const, granularitySeconds: 3_600, points: [point(0), point(1), point(5)], missingIntervals: 3 };
    expect(seriesSegments(series)).toEqual([[0, 1], [2]]);
  });

  it('merges a ticker poll into the market card and leaves the other cards alone', () => {
    const data = response([market(), ...overviewCards]);
    const merged = mergeTicker(data, MarketTickerResponse.parse({ status: 'ok', now: '2026-09-30T12:01:00Z', ticker: { ...TICKER, price: 61_000 }, fetchedAt: '2026-09-30T12:01:00Z' }));
    expect(merged.now).toBe('2026-09-30T12:01:00Z');
    expect(merged.cards[0]).toMatchObject({ id: 'market', status: 'ok', ticker: { price: 61_000 }, fetchedAt: '2026-09-30T12:01:00Z' });
    expect(merged.cards[1]).toEqual(data.cards[1]);
  });
});
