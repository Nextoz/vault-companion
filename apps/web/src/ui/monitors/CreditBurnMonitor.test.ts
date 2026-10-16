// M1b: JSDOM tests for the Credit burn-down monitor. The data is synthetic and parsed through the same contracts the
// app receives, so a contract drift fails here first; the assertions cover the collapsed line, the expanded body,
// the typed refusal, the "nothing to show" case and the stale footer.
import { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreditBurnMonitor } from './CreditBurnMonitor.tsx';

const REV = 'a'.repeat(40);
const now = Date.parse('2026-10-16T12:00:00+02:00');
const TODAY = '2026-10-16';
const RESET = '2026-11-01T00:59:59+01:00'; // 01:59:59 local, so the voucher's vault day is still 31 Oct.
const DAY = 86_400_000;

const daysAgo = (count: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - count * DAY).toISOString().slice(0, 10);
const day = (date: string, cost: number) =>
  ({ date, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost });
/** EUR 2 on each of the last seven local days, oldest first. */
const week = (cost: number) => Array.from({ length: 7 }, (_, index) => day(daysAgo(6 - index), cost));

const scaleway = { id: 'scaleway', label: 'Scaleway credits', kind: 'money', value: 63, limit: 100, unit: '\u20ac', resetsAt: RESET, history: null };
const claude = { id: 'claude', label: 'Claude weekly', kind: 'percent', value: 58, limit: 100, unit: null, resetsAt: '2026-10-19T09:00:00+02:00', history: null };

const budget = AiBudgetResponse.parse({ revision: REV, generatedAt: '2026-10-16T11:30:00+02:00', freeRamGb: null, providers: [scaleway, claude] });
const usage = AiUsageResponse.parse({
  revision: REV, generatedAt: '2026-10-16T11:30:00+02:00', skipped: 0,
  providers: { scaleway: { label: 'Scaleway', currency: 'EUR', days: week(2) } },
});
const ok = <T,>(data: T) => ({ kind: 'ok' as const, data });

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
});

const render = async (props: Parameters<typeof CreditBurnMonitor>[0]) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(CreditBurnMonitor, props)); });
};
const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
const toggle = async () => { await act(async () => { (button('Credit burn-down') as HTMLElement).click(); }); };

describe('CreditBurnMonitor', () => {
  it('starts collapsed: one summary line, no ring or chart, aria-expanded false', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    expect(document.querySelector('.m1-summary')!.textContent).toBe('Scaleway EUR 63 left \u00b7 16 d \u00b7 on pace');
    expect(button('Credit burn-down').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.monitor-body svg')).toBeNull();
    expect(document.querySelectorAll('.m1-chart, .m1-ring')).toHaveLength(0);
    expect(text()).toContain('Updated 11:30');
  });

  it('expands to the ring, the expiry line, the pace, the chart and the other balances', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    await toggle();
    expect(document.querySelector('.m1-ring-value')!.textContent).toBe('EUR 63');
    expect(document.querySelector('.m1-ring-sub')!.textContent).toBe('of 100 left');
    expect(document.querySelector('.m1-expiry')!.textContent).toBe('16 days left \u00b7 expires 31 Oct');
    expect(document.querySelector('.m1-chart polyline')).not.toBeNull();
    expect(document.querySelector('.m1-chart')!.getAttribute('aria-label')).toBe('Spend vs ideal from 10 Oct to 31 Oct');
    expect(document.querySelector('.m1-pace')!.textContent).toBe('On pace: ~EUR 32 left on 31 Oct');
    expect(document.querySelector('.m1-pace')!.className).toContain('m1-pace-ok');
    expect(document.querySelector('.m1-other-label')!.textContent).toContain('Claude weekly');
    expect(document.querySelector('.m1-other-reset')!.textContent).toContain('resets in 2 d');
    expect(document.querySelector('.m1-other-value')!.textContent).toBe('58 % used');
    expect(document.querySelector('.m1-bar-fill')!.getAttribute('style')).toContain('width: 58%');
  });

  it('reports a budget without a Scaleway money row in both states', async () => {
    await render({ usage: ok(usage), budget: ok(AiBudgetResponse.parse({ ...budget, providers: [claude] })), now });
    expect(text()).toContain('No Scaleway voucher in the budget file.');
    expect(document.querySelector('.m1-summary')).toBeNull();
    await toggle();
    expect(text()).toContain('No Scaleway voucher in the budget file.');
    expect(document.querySelector('.m1-body')).toBeNull();
  });

  it('renders nothing while neither read has answered', async () => {
    await render({ usage: null, budget: null, now });
    expect(document.getElementById('root')!.innerHTML).toBe('');
  });

  it('marks a three-hour-old budget stale in the footer', async () => {
    const old = AiBudgetResponse.parse({ ...budget, generatedAt: '2026-10-16T09:00:00+02:00' });
    await render({ usage: ok(usage), budget: ok(old), now });
    const footer = document.querySelector('.dash-stale')!;
    expect(footer.textContent).toBe('Scaleway console \u00b7 vendor APIs \u00b7 Stale (> 2 h)');
    expect(text()).toContain('Scaleway EUR 63 left');
  });
});
