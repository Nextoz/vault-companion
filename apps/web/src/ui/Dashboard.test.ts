import { DashboardResponse, HealthResponse, MarketTickerResponse, type DashboardCard } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDashboard, getHealth, getMarketTicker, getPower, getSky, getWeather, type Fetched } from '../api.ts';
import { lastCopies } from '../lastCopy.ts';
import { DASHBOARD_RANGES, Dashboard, MARKET_STALE_MS, RANGE_LABELS, mergeTicker, overviewTiles, seriesSegments } from './Dashboard.tsx';

vi.mock('../api.ts', () => ({ getJson: vi.fn(() => new Promise(() => {})), getDashboard: vi.fn(), getHealth: vi.fn(), getMarketTicker: vi.fn(), getPower: vi.fn(), getSky: vi.fn(), getWeather: vi.fn() }));

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
];
const watchPoint = (index: number, close: number) => ({ time: new Date(Date.parse(NOW) - (2 - index) * 3_600_000).toISOString(), open: close, high: close, low: close, close });
const watchSeries = (closes: readonly number[]) => ({ range: '1W' as const, granularitySeconds: 3_600, points: closes.map((close, index) => watchPoint(index, close)), missingIntervals: 0 });
const watch = (over: Record<string, unknown> = {}): DashboardCard => ({
  id: 'watchlist', status: 'ok', title: 'BTC / USD', provenance: 'Coinbase Exchange (public)',
  observedAt: NOW, fetchedAt: NOW, note: null, drillthrough: null, item: { symbol: 'BTC-USD', type: 'crypto' },
  ticker: { base: 'BTC', quote: 'USD', provider: 'coinbase', price: 60123.45, providerTime: NOW },
  series: watchSeries([60_000, 60_123.45]),
  ...over,
} as DashboardCard);
const response = (cards: DashboardCard[] = [market(), ...overviewCards]) => DashboardResponse.parse({ now: NOW, cards });
const ok = (cards?: DashboardCard[]) => ({ kind: 'ok' as const, data: response(cards) });
const healthMissing = () => ({ kind: 'ok' as const, data: HealthResponse.parse({ revision: 'a'.repeat(40), now: NOW, status: 'missing', metrics: [] }) });
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
  vi.mocked(getHealth).mockResolvedValue(healthMissing());
  vi.mocked(getPower).mockResolvedValue({ kind: 'offline' });
  vi.mocked(getSky).mockResolvedValue({ kind: 'offline' });
  vi.mocked(getWeather).mockResolvedValue({ kind: 'offline' });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
  vi.useRealTimers();
  vi.clearAllMocks();
  lastCopies.clear();
});

// S-markets: the Markets card is collapsed on every mount. `render` opens it and its first row (the chart) unless a
// test passes `{ open: false }`; `openRow` opens another row by its label.
const render = async (cards?: DashboardCard[], onDrillthrough?: (view: string) => void, options: { open?: boolean } = {}) => {
  vi.mocked(getDashboard).mockResolvedValue(ok(cards));
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0, onDrillthrough })); });
  if (options.open !== false) await openMarkets();
  return root;
};
const openMarkets = async () => {
  const head = document.querySelector('.markets .monitor-head') as HTMLElement | null;
  if (head && head.getAttribute('aria-expanded') !== 'true') await act(async () => { head.click(); });
  const row = document.querySelector('.markets-row') as HTMLElement | null;
  if (row && row.getAttribute('aria-expanded') !== 'true') await act(async () => { row.click(); });
};
const labels = () => [...document.querySelectorAll('.markets-label')].map((el) => el.textContent);
const item = (label: string) => [...document.querySelectorAll('.markets-item')].find((el) => el.querySelector('.markets-label')?.textContent === label)!;
const openRow = async (label: string) => {
  const row = [...document.querySelectorAll('.markets-row')].find((r) => r.querySelector('.markets-label')?.textContent === label) as HTMLElement;
  if (row.getAttribute('aria-expanded') !== 'true') await act(async () => { row.click(); });
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

  it('hides a placeholder card that only says "Not configured" instead of an empty tile', async () => {
    await render();
    expect(text()).not.toContain('AI usage');
    expect(text()).not.toContain('Not configured');
    expect(document.querySelector('.dash-tiles')).toBeNull();
    expect(text()).toContain('$60,123.45');
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
    expect(document.querySelector('.markets-row')!.textContent).toContain('unavailable');
    expect(text()).toContain('The market provider is unavailable right now.');
    expect(document.querySelector('.markets-value')!.textContent).toBe('—'); // never a number
    expect(document.querySelector('.markets')).not.toBeNull();
  });
});

describe('overviewTiles (UX4)', () => {
  it('drops placeholders and self-hosted cards, keeping an honest Unavailable tile', () => {
    const failedUsage: DashboardCard = { id: 'ai-usage', status: 'unavailable', title: 'AI usage', provenance: 'Not configured', observedAt: null, fetchedAt: null, note: 'The source is down.', drillthrough: null };
    expect(overviewTiles([market(), ...overviewCards, failedUsage]).map((card) => card.status)).toEqual(['unavailable']);
    expect(overviewTiles([market()])).toEqual([]);
  });
});

describe('watchlist cards (WL2)', () => {
  it('renders one card per watched item and hides the legacy market card, so BTC is not shown twice', async () => {
    const fx = watch({ item: { symbol: 'RUB/DKK', type: 'fx' }, title: 'ignored', ticker: { base: 'RUB', quote: 'DKK', provider: 'frankfurter', price: 0.0712, providerTime: NOW }, series: watchSeries([0.07, 0.0712]) });
    await render([market(), watch(), fx, ...overviewCards]);
    expect(labels()).toEqual(['BTC', 'RUB/DKK']); // the legacy market card is not a third row
    expect(text()).toContain('$60,123.45');
    expect(text()).toContain('DKK 0.0712');
  });

  it('renders the legacy market card as before when the response has no watchlist cards', async () => {
    await render();
    expect(labels()).toEqual(['BTC']);
  });

  it('shows an unavailable card as its reason note, never a stale number', async () => {
    const down: DashboardCard = { id: 'watchlist', status: 'unavailable', title: 'ETH / USD', provenance: 'Coinbase Exchange (public)', observedAt: null, fetchedAt: null, note: 'The market provider is unavailable right now.', drillthrough: null, item: { symbol: 'ETH-USD', type: 'crypto' }, reason: 'provider-error' };
    await render([down, ...overviewCards]);
    const card = document.querySelector('.markets-item')!;
    expect(card.querySelector('.markets-row')!.textContent).toContain('unavailable');
    expect(card.querySelector('.markets-price')).toBeNull();
    expect(card.textContent).toContain('The market provider is unavailable right now.');
    expect(card.textContent).not.toContain('$');
  });

  it('shows a signed, coloured change over the range: a rise up, a fall down', async () => {
    const falling = watch({ item: { symbol: 'ETH-USD', type: 'crypto' }, ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 2970, providerTime: NOW }, series: watchSeries([3_000, 2_970]) });
    await render([watch({ series: watchSeries([60_000, 60_600]) }), falling, ...overviewCards]);
    expect(document.querySelector('.markets-change.markets-up')!.textContent).toContain('+1.00%');
    expect(document.querySelector('.markets-change.markets-down')!.textContent).toContain('-1.00%');
  });

  it('says the current value stands alone when the history read failed', async () => {
    await render([watch({ series: null, note: 'Current value only. The market provider did not answer in time. History is not shown.' }), ...overviewCards]);
    expect(text()).toContain('Current value only');
    expect(document.querySelector('.dash-svg')).toBeNull();
  });

  it('reads out a watch point in the quote currency and precision, not the market default', async () => {
    const fx = watch({ item: { symbol: 'RUB/DKK', type: 'fx' }, ticker: { base: 'RUB', quote: 'DKK', provider: 'frankfurter', price: 0.09, providerTime: NOW }, series: watchSeries([0.05, 0.0712, 0.09]) });
    await render([fx, ...overviewCards]);
    expect(document.querySelector('.dash-readout')!.textContent).toContain('DKK 0.0900');
    expect(document.querySelector('.dash-readout')!.textContent).not.toContain('$');
  });

  it('shows a stock as "Delayed" with its provider time, while crypto/fx stay unlabelled', async () => {
    const nvidia = watch({ item: { symbol: 'NVDA', type: 'stock' }, title: 'NVIDIA', provenance: 'Yahoo Finance', ticker: { base: 'NVDA', quote: 'USD', provider: 'Yahoo Finance', price: 229.28, providerTime: NOW }, series: watchSeries([183.16, 229.28]) });
    await render([nvidia, watch(), ...overviewCards]);
    const stockCard = item('NVDA');
    expect(stockCard.querySelector('.dash-svg')!.getAttribute('aria-label')).toContain('NVIDIA (NVDA)');
    expect(stockCard.querySelector('.dash-chip-delayed')!.textContent).toBe('Delayed');
    expect(stockCard.textContent).toContain('Market time');
    expect(stockCard.textContent).toContain('12:00 UTC');
    expect(stockCard.textContent).toContain('$229.28');
    await openRow('BTC');
    expect(item('BTC').querySelector('.dash-chip-delayed')).toBeNull();
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
    await openMarkets();
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
    await openMarkets();
    expect(document.querySelector('.dash-svg')).not.toBeNull();
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });

  it('asks for the new range and ignores a late reply from the range the user left', async () => {
    const oneWeek = deferred<Fetched<DashboardResponse>>();
    vi.mocked(getDashboard).mockImplementation((range) => (range === '1W' ? oneWeek.promise : Promise.resolve(ok([market({ series: { range: '1M', granularitySeconds: 21_600, points: [point(0), point(1)], missingIntervals: 0 } }), ...overviewCards]))));
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0 })); });
    await openMarkets(); // the card is mounted (loading) and its range buttons are in its open header
    await click(button('1M'));
    await flush();
    await openMarkets();
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
    await openMarkets();
    expect(text()).toContain('Stale');
    expect(text()).toContain('$60,123.45'); // the known value is still shown, labelled
    expect(document.querySelector('.markets')).not.toBeNull(); // the other cards are still there
  });

  it('marks data stale once it is older than the freshness window', async () => {
    const old = market({ fetchedAt: new Date(Date.parse(NOW) - MARKET_STALE_MS - 1).toISOString() });
    await render([old, ...overviewCards]);
    expect(text()).toContain('Stale');
    expect(text()).toContain('not fresh');
  });

  // WL3: the 1Y chip asks for 1Y and the chart is labelled "1 year", not the 3M copy.
  it('offers a 1Y chip that fetches 1Y and labels the chart "1 year"', async () => {
    await render();
    const chip = button('1Y');
    expect(chip).toBeDefined();
    vi.mocked(getDashboard).mockResolvedValue(ok([
      market({ series: { range: '1Y', granularitySeconds: 86_400, points: [point(0), point(1)], missingIntervals: 0 } }), ...overviewCards,
    ]));
    await click(chip);
    await flush();
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(getDashboard)).toHaveBeenLastCalledWith('1Y');
    expect(document.querySelector('.dash-svg')!.getAttribute('aria-label')).toContain('1 year');
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

describe('last copy per range (SP3c, ADR-0038)', () => {
  const mount = async (accountKey: string | null) => {
    root = createRoot(document.getElementById('root')!);
    await act(async () => { root!.render(createElement(Dashboard, { refreshKey: 0, accountKey })); });
  };
  const remount = async (accountKey: string | null) => {
    await act(async () => root!.unmount());
    await mount(accountKey);
  };

  it('reopens a range seen before from its labelled copy, and never shows it for another range', async () => {
    vi.mocked(getDashboard).mockResolvedValue(ok());
    await mount('account-a');
    expect(document.querySelector('[data-testid="copy-note"]')).toBeNull();
    const pending = deferred<Fetched<DashboardResponse>>();
    vi.mocked(getDashboard).mockReturnValue(pending.promise);
    await remount('account-a');
    await openMarkets();
    expect(text()).toContain('$60,123.45');
    expect(document.querySelector('[data-testid="copy-note"]')!.textContent).toMatch(/^Showing the copy from \d\d:\d\d · refreshing…$/);
    expect(text()).toContain('Stale'); // a copy is never labelled Live
    await click(button('1M'));
    expect(text()).toContain('Loading…'); // 1M was never seen: no copy, and the 1W copy is not reused for it
    expect(text()).not.toContain('$60,123.45');
    await click(button('1W'));
    await act(async () => { pending.resolve({ kind: 'error', message: 'synthetic failure' }); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="copy-note"]')!.textContent).toMatch(/^Could not refresh · showing the copy from \d\d:\d\d$/);
    expect(button('Retry dashboard')).toBeDefined();
    await remount('account-b');
    expect(text()).not.toContain('$60,123.45'); // another account never sees this copy
  });

  it('merges the ticker into live answers only: the copy keeps the read it came from', async () => {
    vi.useFakeTimers();
    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    vi.mocked(getMarketTicker).mockResolvedValue({ kind: 'ok', data: MarketTickerResponse.parse({ status: 'ok', now: later, ticker: { ...TICKER, price: 61000, providerTime: later }, fetchedAt: later }) });
    vi.mocked(getDashboard).mockResolvedValue(ok());
    await mount('account-a');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await openMarkets();
    expect(text()).toContain('$61,000.00');
    vi.mocked(getDashboard).mockResolvedValue({ kind: 'error', message: 'synthetic failure' });
    await remount('account-a');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await openMarkets();
    expect(text()).toContain('$60,123.45');
    expect(text()).not.toContain('$61,000.00');
  });

  it('ignores a ticker poll older than the answer it would patch', async () => {
    vi.useFakeTimers();
    const earlier = new Date(Date.parse(NOW) - 60_000).toISOString();
    vi.mocked(getMarketTicker).mockResolvedValue({ kind: 'ok', data: MarketTickerResponse.parse({ status: 'ok', now: earlier, ticker: { ...TICKER, price: 59000, providerTime: earlier }, fetchedAt: earlier }) });
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(text()).toContain('$60,123.45');
    expect(text()).not.toContain('$59,000.00');
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
    const card = { ...overviewCards[0]!, status: 'unavailable', note: 'The source is down.', drillthrough: { label: 'Usage detail', view: 'usage' } } as DashboardCard;
    await render([market(), card], onDrillthrough);
    await click(button('Usage detail'));
    expect(onDrillthrough).toHaveBeenCalledWith('usage');
  });
});

describe('private-valuation card (WL4b)', () => {
  const privateOk: DashboardCard = {
    id: 'private-valuation', status: 'ok', title: 'OpenAI', provenance: 'Vault: Automation/Watchlist/private-valuations.json',
    observedAt: null, fetchedAt: NOW, note: null, drillthrough: null,
    item: { id: 'openai', name: 'OpenAI', valueUsdBillions: 500, asOf: '2026-03-12', source: { label: 'Synthetic round report', url: 'https://example.test/openai-round' } },
  };

  it('renders the labelled private line and an https source link, with no chart, price or delayed chip', async () => {
    await render([privateOk, ...overviewCards]);
    const card = item('OpenAI');
    expect(card.querySelector('.markets-row')!.textContent).toContain('last round');
    expect(card.querySelector('.markets-row')!.textContent).toContain('$500 B');
    expect(card.querySelector('.markets-spark')).toBeNull();
    expect(card.textContent).toContain('OpenAI');
    expect(card.textContent).toContain('private · last round ~USD 500 B · 12 Mar 2026');
    const link = card.querySelector('.dash-private-source') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.test/openai-round');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(card.querySelector('.dash-svg')).toBeNull();
    expect(card.querySelector('.dash-price')).toBeNull();
    expect(card.querySelector('.dash-chip-delayed')).toBeNull();
    expect(document.querySelector('.dash-tiles')).toBeNull(); // shown as its own card, never a generic tile
  });

  it('shows the plain unavailable reason and never a figure', async () => {
    const down: DashboardCard = {
      id: 'private-valuation', status: 'unavailable', title: 'Private valuations', provenance: 'Vault: Automation/Watchlist/private-valuations.json',
      observedAt: null, fetchedAt: null, note: 'No private-valuation file exists yet.', drillthrough: null, reason: 'not-found',
    };
    await render([down, ...overviewCards]);
    const card = item('Private valuations');
    expect(card.querySelector('.markets-value')!.textContent).toBe('—');
    expect(card.textContent).toContain('No private-valuation file exists yet.');
    expect(card.textContent).not.toContain('USD');
    expect(card.querySelector('.dash-private-value')).toBeNull();
    expect(card.querySelector('.dash-svg')).toBeNull();
  });
});

describe('Markets card (compact rows)', () => {
  const eth = () => watch({ item: { symbol: 'ETH-USD', type: 'crypto' }, ticker: { base: 'ETH', quote: 'USD', provider: 'coinbase', price: 2970, providerTime: NOW }, series: watchSeries([3_000, 2_970]) });
  const fx = () => watch({ item: { symbol: 'RUB/DKK', type: 'fx' }, ticker: { base: 'RUB', quote: 'DKK', provider: 'frankfurter', price: 0.0712, providerTime: NOW }, series: watchSeries([0.07, 0.0712]) });

  it('is collapsed by default with a one-line summary of the first two markets and "+N more"', async () => {
    await render([watch({ series: watchSeries([60_000, 60_600]) }), eth(), fx(), ...overviewCards], undefined, { open: false });
    expect(document.querySelector('.markets .monitor-head')!.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.markets-summary')!.textContent).toBe('BTC +1.00% · ETH -1.00% · +1 more');
    expect(document.querySelector('.markets-list')).toBeNull();
    expect(document.querySelector('.markets-range')).toBeNull(); // the range buttons belong to the open card
  });

  it('opens one compact row per market and only one chart at a time', async () => {
    await render([watch(), eth(), fx(), ...overviewCards], undefined, { open: false });
    await openMarkets();
    expect(labels()).toEqual(['BTC', 'ETH', 'RUB/DKK']);
    expect(document.querySelectorAll('.markets-spark')).toHaveLength(3);
    expect(document.querySelectorAll('.dash-svg')).toHaveLength(1); // the first row is open (render helper)
    await openRow('ETH');
    expect(document.querySelectorAll('.dash-svg')).toHaveLength(1);
    expect(item('ETH').querySelector('.dash-svg')).not.toBeNull();
    expect(item('BTC').querySelector('.markets-row')!.getAttribute('aria-expanded')).toBe('false');
    await click(item('ETH').querySelector('.markets-row')!);
    expect(document.querySelectorAll('.dash-svg')).toHaveLength(0);
  });

  it('keeps the card open and its range buttons usable while another range loads', async () => {
    await render([watch(), ...overviewCards]);
    const pending = deferred<Fetched<DashboardResponse>>();
    vi.mocked(getDashboard).mockReturnValue(pending.promise);
    await click(button('1M'));
    expect(document.querySelector('.markets .monitor-head')!.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('Loading markets…');
    expect(button('1M').getAttribute('aria-pressed')).toBe('true');
  });

  it('marks a stale row in words and never as live, and keeps its last number labelled', async () => {
    const old = watch({ fetchedAt: new Date(Date.parse(NOW) - MARKET_STALE_MS - 1).toISOString() });
    await render([old, ...overviewCards], undefined, { open: false });
    expect(document.querySelector('.markets-summary')!.textContent).toContain('(stale)');
    await openMarkets();
    expect(document.querySelector('.markets-row .visually-hidden')!.textContent).toContain('stale');
    expect(document.querySelector('.markets-price')!.className).toContain('muted');
    expect(text()).toContain('not fresh');
  });

  it('keeps the drillthrough link of the open market', async () => {
    const onDrillthrough = vi.fn();
    await render([watch({ drillthrough: { label: 'Open BTC detail', view: 'btc' } }), ...overviewCards], onDrillthrough);
    await click(button('Open BTC detail'));
    expect(onDrillthrough).toHaveBeenCalledWith('btc');
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

  it('lists 1Y last with its human label', () => {
    expect(RANGE_LABELS['1Y']).toBe('1 year');
    expect(DASHBOARD_RANGES).toEqual(['1W', '1M', '3M', '1Y']);
  });
});
