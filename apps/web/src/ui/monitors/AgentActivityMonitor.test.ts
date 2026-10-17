import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ACTIVITY_FAILED, AGENT_ACTIVITY_MISSING, AgentActivityMonitor } from './AgentActivityMonitor.tsx';

const fixture = { revision: 'a'.repeat(40), ...JSON.parse(readFileSync(new URL('./fixtures/agent-activity.json', import.meta.url), 'utf8')) };
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
  await act(async () => { root!.render(createElement(AgentActivityMonitor, { nowMs })); });
};
const text = () => document.getElementById('root')!.textContent ?? '';
const head = () => document.querySelector('button.monitor-head') as HTMLElement;

describe('AgentActivityMonitor', () => {
  it('starts collapsed on the one-line summary and reads the fixed route', async () => {
    answer(200);
    await mount();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(text()).toContain('3 PRs merged · CI green · 1 needs you');
    expect(document.querySelectorAll('.aa-row')).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/monitors/agent-activity');
  });

  it('expands to merged and open PRs, the action items, spend and the freshness line', async () => {
    answer(200);
    await mount();
    await act(async () => { head().click(); });
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('CI green · deploy green');
    expect(document.querySelectorAll('.aa-row')).toHaveLength(6);
    expect(document.querySelectorAll('.aa-chip-ok')).toHaveLength(3);
    expect(text()).toContain('#208 · Synthetic change 208');
    expect(text()).toContain('+654 −56');
    expect(text()).toContain('Synthetic action: pick between two layouts.');
    expect(text()).toContain('Scaleway EUR 3.20 today');
    expect(text()).toContain('GitHub · AI usage · Updated 19:17');
  });

  it('labels a file older than the hourly cadence as stale instead of current', async () => {
    answer(200);
    await mount(GENERATED + 5 * 3_600_000);
    expect(text()).toContain('Stale · Updated 16 Oct 19:17');
    expect(document.querySelector('.aa-foot')!.className).toContain('dash-stale');
  });

  it('says when the Lead action log is stale rather than claiming nothing needs the owner', async () => {
    answer(200, { ...fixture, needsYou: { ...fixture.needsYou, stale: true, items: [] } });
    await mount();
    expect(text()).toContain('action log stale');
    await act(async () => { head().click(); });
    expect(text()).toContain('has not been updated in the last 24 hours');
    expect(text()).not.toContain('Nothing needs you right now.');
  });

  it('says so when the read fails, showing no counts', async () => {
    answer(500, {});
    await mount();
    expect(text()).toContain(AGENT_ACTIVITY_FAILED);
    expect(text()).not.toContain('merged');
  });

  it('says nothing has been published when the file does not exist yet', async () => {
    answer(404, {});
    await mount();
    expect(text()).toContain(AGENT_ACTIVITY_MISSING);
  });

  it('rejects a reply that is not the agent activity shape rather than drawing it', async () => {
    answer(200, { ...fixture, windowHours: 'day' });
    await mount();
    expect(text()).toContain(AGENT_ACTIVITY_FAILED);
  });
});
