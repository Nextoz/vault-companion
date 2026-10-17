import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VAULT_HEATMAP_FAILED, VAULT_HEATMAP_MISSING, VaultHeatmapMonitor } from './VaultHeatmapMonitor.tsx';

const fixture = { revision: 'a'.repeat(40), ...JSON.parse(readFileSync(new URL('./fixtures/vault-activity.json', import.meta.url), 'utf8')) };
const GENERATED = Date.parse(fixture.generatedAt);

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
  vi.unstubAllGlobals();
});

const answer = (status: number, body: unknown = fixture) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
const mount = async (nowMs = GENERATED + 60_000) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(VaultHeatmapMonitor, { nowMs })); });
};
const text = () => document.getElementById('root')!.textContent ?? '';
const head = () => document.querySelector('button.monitor-head') as HTMLElement;

describe('VaultHeatmapMonitor', () => {
  it('starts collapsed on the one-line summary and reads the fixed route', async () => {
    answer(200);
    await mount();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(text()).toContain(`23-day streak · ${fixture.notesThisMonth} notes this month`);
    expect(document.querySelectorAll('.vh-cell')).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/monitors/vault-activity');
  });

  it('expands to the full grid of 182 days, the legend, the area bar and the freshness line', async () => {
    answer(200);
    await mount();
    await act(async () => { head().click(); });
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.vh-cell')).toHaveLength(182);
    expect(document.querySelectorAll('.vh-today')).toHaveLength(1);
    expect(text()).toContain('Current streak 23 days');
    expect(text()).toContain('NOTES BY AREA · 30 DAYS');
    expect(text()).toContain('Projects 28');
    expect(text()).toContain('Vault git history · Updated 05:40');
  });

  it('labels a file older than the producer cadence as stale instead of current', async () => {
    answer(200);
    await mount(GENERATED + 30 * 3_600_000);
    expect(text()).toContain('Stale · Updated 16 Oct 05:40');
    expect(document.querySelector('.vh-foot')!.className).toContain('dash-stale');
  });

  it('says so when the read fails, showing no number', async () => {
    answer(500, {});
    await mount();
    expect(text()).toContain(VAULT_HEATMAP_FAILED);
    expect(text()).not.toContain('streak');
  });

  it('says nothing has been published when the file does not exist yet', async () => {
    answer(404, {});
    await mount();
    expect(text()).toContain(VAULT_HEATMAP_MISSING);
  });

  it('rejects a reply that is not the vault activity shape rather than drawing it', async () => {
    answer(200, { ...fixture, currentStreak: 'many' });
    await mount();
    expect(text()).toContain(VAULT_HEATMAP_FAILED);
  });
});
