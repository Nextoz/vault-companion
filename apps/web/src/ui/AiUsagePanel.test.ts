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

describe('AiUsagePanel', () => {
  it('draws one tile per provider, the budget left line and the Updated footer', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    expect(document.querySelector('.ai-usage-tile')).not.toBeNull();
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
    expect(text()).toContain('Claude');
    expect(text()).toContain('92 % used');
    expect(text()).toContain('Updated 12:30');
    expect(document.querySelector('.ai-usage-spark')!.getAttribute('aria-label')).toBe('Claude: 7 days of tokens');
  });

  it('toggles 7 d / 30 d', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    expect(button('7 d').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { (button('30 d') as HTMLElement).click(); });
    expect(button('30 d').getAttribute('aria-pressed')).toBe('true');
    expect(button('7 d').getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.ai-usage-spark')!.getAttribute('aria-label')).toBe('Claude: 30 days of tokens');
  });

  it('titles an unknown provider with its id and never breaks', async () => {
    await render({ usage: ok(usage), budget: ok(budget), now });
    const titles = [...document.querySelectorAll('.ai-usage-provider')].map((entry) => entry.textContent);
    expect(titles).toEqual(['Claude', 'mystery']);
  });

  it('does not draw a left line when the budget has no row', async () => {
    await render({ usage: ok(usage), budget: null, now });
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
    expect(document.querySelector('.ai-usage-left')).toBeNull();
  });

  it('shows no numbers when the read failed, and renders nothing before it is requested', async () => {
    await render({ usage: { kind: 'error', message: 'The server answered 503.' }, budget: ok(budget), now });
    expect(text()).toContain('AI usage could not be read.');
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(0);
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
    expect(document.querySelectorAll('.ai-usage-tile')).toHaveLength(2);
    expect(text()).toContain('92 % used');
  });
});
