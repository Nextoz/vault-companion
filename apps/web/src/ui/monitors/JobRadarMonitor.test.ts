import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_RADAR_FAILED, JOB_RADAR_MISSING, JobRadarMonitor } from './JobRadarMonitor.tsx';

const fixture = { revision: 'a'.repeat(40), ...JSON.parse(readFileSync(new URL('./fixtures/job-radar.json', import.meta.url), 'utf8')) };
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
  await act(async () => { root!.render(createElement(JobRadarMonitor, { nowMs })); });
};
const text = () => document.getElementById('root')!.textContent ?? '';
const head = () => document.querySelector('button.monitor-head') as HTMLElement;

describe('JobRadarMonitor', () => {
  it('starts collapsed on the one-line summary and reads the fixed route', async () => {
    answer(200);
    await mount();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(text()).toContain('9 applied · 1 interview · 2 follow-ups');
    expect(document.querySelectorAll('.jr-stage')).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/monitors/job-radar');
  });

  it('expands to the pipeline stages, the dated follow-ups with chips, six in flight and the freshness line', async () => {
    answer(200);
    await mount();
    await act(async () => { head().click(); });
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('PIPELINE');
    expect([...document.querySelectorAll('.jr-stage .jr-label')].map((el) => el.textContent)).toEqual(['Saved', 'Applied', 'Interview', 'Offer', 'Closed']);
    expect([...document.querySelectorAll('.jr-stage .jr-count')].map((el) => el.textContent)).toEqual(['19', '9', '1', '0', '11']);
    expect(text()).toContain('FOLLOW-UPS DUE');
    expect(document.querySelectorAll('.jr-followups .jr-row')).toHaveLength(2);
    expect(text()).toContain('Acme Platform');
    expect(text()).toContain('14 Oct');
    expect(document.querySelector('.jr-chip-overdue')!.textContent).toBe('overdue');
    expect(text()).toContain('Beta Backend');
    expect(text()).toContain('18 Oct');
    expect(document.querySelector('.jr-chip-soon')!.textContent).toBe('due soon');
    expect(text()).toContain('IN FLIGHT');
    expect(document.querySelectorAll('.jr-flight .jr-row')).toHaveLength(6);
    expect(text()).toContain('Updated 4 days ago');
    expect(text()).not.toContain('Eta Platform');
    expect(text()).toContain('Job Search 2026 notes · Updated 06:10');
  });

  it('labels a file older than the daily run as stale instead of current', async () => {
    answer(200);
    await mount(GENERATED + 30 * 3_600_000);
    expect(text()).toContain('Job Search 2026 notes · Stale · Updated 16 Oct 06:10');
    expect(document.querySelector('.jr-foot')!.className).toContain('dash-stale');
  });

  it('says so when the read fails, showing no count', async () => {
    answer(500, {});
    await mount();
    expect(text()).toContain(JOB_RADAR_FAILED);
    expect(text()).not.toContain('applied');
  });

  it('says nothing has been published when the file does not exist yet', async () => {
    answer(404, {});
    await mount();
    expect(text()).toContain(JOB_RADAR_MISSING);
  });

  it('rejects a reply that is not the job radar shape rather than drawing it', async () => {
    answer(200, { ...fixture, counts: { ...fixture.counts, applied: 'many' } });
    await mount();
    expect(text()).toContain(JOB_RADAR_FAILED);
  });

  it('says no follow-up has a date when none of the notes carries one', async () => {
    answer(200, { ...fixture, followUps: [] });
    await mount();
    await act(async () => { head().click(); });
    expect(text()).toContain('No follow-up has a date in the notes.');
  });
});
