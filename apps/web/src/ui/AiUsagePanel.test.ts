import { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUsagePanel } from './AiUsagePanel.tsx';

const REV = 'a'.repeat(40);
const now = Date.parse('2026-10-04T13:00:00+02:00');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dates = Array.from({ length: 10 }, (_, index) => iso(Date.parse('2026-09-25T00:00:00Z') + index * DAY));

const usage = AiUsageResponse.parse({
  revision: REV, generatedAt: '2026-10-04T12:30:00+02:00', skipped: 0,
  providers: {
    claude: { label: 'Claude', days: dates.map((date) => ({ date, calls: 1, inputTokens: 0, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 9_999, cost: 0 })) },
    mystery: { days: [{ date: '2026-10-04', calls: 3, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0 }] },
  },
});
const budget = AiBudgetResponse.parse({
  revision: REV, generatedAt: '2026-10-04T08:00:00+02:00', freeRamGb: null,
  providers: [{ id: 'claude', label: 'Claude weekly', kind: 'percent', value: 92, limit: 100, unit: null, resetsAt: null, history: null }],
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

const render = async (props: Parameters<typeof AiUsagePanel>[0]) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(AiUsagePanel, props)); });
};
const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
const toggle = async () => { await act(async () => { (button('AI usage') as HTMLElement).click(); }); };

describe('AiUsagePanel', () => {
  it('starts collapsed: one summary row per provider, no tiles, sparklines or notes', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    expect(document.querySelectorAll('.ai-usage-row')).toHaveLength(2);
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(0);
    expect(document.querySelector('.ai-usage-spark')).toBeNull();
    expect(document.querySelector('.ai-usage-period')).toBeNull();
    expect(document.querySelector('.ai-usage-note')).toBeNull();
    expect([...document.querySelectorAll('.ai-usage-row-value')].map((node) => node.textContent))
      .toEqual(['700 tokens', '3 calls']);
    expect(text()).toContain('Updated 12:30');
  });

  it('flips aria-expanded on the header button, which controls the body', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    const head = button('AI usage');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(head.getAttribute('aria-controls')!)).not.toBeNull();
    await act(async () => { (head as HTMLElement).click(); });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.ai-usage-row')).toHaveLength(0);
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
  });

  it('offers the 7 d / 30 d toggle only once expanded', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    expect(document.querySelector('.ai-usage-range')).toBeNull();
    await toggle();
    expect(document.querySelector('.ai-usage-range')).not.toBeNull();
    expect(button('7 d').getAttribute('aria-pressed')).toBe('true');
  });

  it('carries the budget tone into the collapsed row as a coloured dot', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    const left = document.querySelector('.ai-usage-row .ai-usage-row-left')!;
    expect(left.className).toContain('ai-usage-left-bad'); // 92 % used is past the 90 threshold.
    expect(left.textContent).toBe('92 % used');
    expect(document.querySelector('.ai-usage-row .ai-usage-dot')).not.toBeNull();
    expect(document.querySelectorAll('.ai-usage-row-left')).toHaveLength(1); // mystery has no budget row.
  });

  it('expands to one tile per provider, the budget left line and the Updated footer', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    await toggle();
    expect(document.querySelector('.ai-usage-tile')).not.toBeNull();
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
    expect(text()).toContain('Claude');
    expect(text()).toContain('92 % used');
    expect(document.querySelector('.ai-usage-value')!.textContent).toBe('700 tokens');
    expect(document.querySelector('.ai-usage-period')!.textContent).toContain('28 Sep–4 Oct · 7 days');
    expect(text()).toContain('Updated 12:30');
    expect(document.querySelector('.ai-usage-spark')!.getAttribute('aria-label')).toBe('Claude: 7 days of tokens');
  });

  it('toggles 7 d / 30 d, and the collapsed summary follows the chosen range', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    await toggle();
    expect(button('7 d').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { (button('30 d') as HTMLElement).click(); });
    expect(button('30 d').getAttribute('aria-pressed')).toBe('true');
    expect(button('7 d').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.ai-usage-spark')!.getAttribute('aria-label')).toBe('Claude: 30 days of tokens');
    expect(document.querySelector('.ai-usage-value')!.textContent).toBe('1,000 tokens');
    expect(text()).toContain('10 of 30 days recorded; missing days excluded');
    await toggle();
    expect(document.querySelector('.ai-usage-row-value')!.textContent).toBe('1,000 tokens');
  });

  it('titles an unknown provider with its id and never breaks', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    const titles = [...document.querySelectorAll('.ai-usage-provider')].map((entry) => entry.textContent);
    expect(titles).toEqual(['Claude', 'mystery']);
  });

  it('does not draw a left line when the budget has no row', async () => {
    await render({ usage: ok(usage), budget: null, now });
    await toggle();
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
    expect(document.querySelector('.ai-usage-left')).toBeNull();
  });

  it('shows observed zero, unavailable usage and cost currency as distinct headlines', async () => {
    const sample = (cost: number) => ({ date: '2026-10-04', calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost });
    const data = AiUsageResponse.parse({ ...usage, providers: {
      jev: { days: [sample(0)] },
      codex: { days: [] },
      scaleway: { currency: 'EUR', days: [sample(1.5)] },
      deepseek: { days: [sample(2)] },
    } });
    await render({ usage: ok(data), budget: null, now });
    await toggle();
    expect([...document.querySelectorAll('.ai-usage-value')].map((node) => node.textContent))
      .toEqual(['0 calls', 'Usage unavailable', '€1.50 cost', '2.00 cost (currency unknown)']);
  });

  it('shows no numbers when the read failed, and renders nothing before it is requested', async () => {
    await render({ usage: { kind: 'error', message: 'The server answered 503.' }, budget: ok(budget), now });
    expect(text()).toContain('AI usage could not be read.');
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(0);
    expect(document.querySelectorAll('.ai-usage-row')).toHaveLength(0);
    await toggle();
    expect(text()).toContain('AI usage could not be read.');
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(0);
    expect(document.querySelectorAll('.ai-usage-row')).toHaveLength(0);
    await act(async () => root!.unmount());
    root = null;
    await render({ usage: null, budget: null, now });
    expect(document.getElementById('root')!.innerHTML).toBe('');
  });

  it('labels a stale file stale but still draws only the numbers it carried', async () => {
    const old = AiUsageResponse.parse({ ...usage, generatedAt: '2026-10-04T09:00:00+02:00' });
    await render({ usage: ok(old), budget: ok(budget), now });
    const footer = document.querySelector('.ai-usage-updated')!;
    expect(footer.className).toContain('dash-stale');
    expect(footer.textContent).toContain('stale (> 2 h)');
    expect(text()).toContain('92 % used');
    await toggle();
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
  });
});
