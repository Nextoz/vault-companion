import { RadarResponse, ScoutsResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRadar, getRadarNote, getScoutOutput, getScouts, postRadarDecision } from '../api.ts';
import { Scouts } from './Scouts.tsx';

vi.mock('../api.ts', () => ({
  getScouts: vi.fn(),
  getScoutOutput: vi.fn(),
  getRadar: vi.fn(),
  getRadarNote: vi.fn(),
  postRadarDecision: vi.fn(),
}));

const REV = 'a'.repeat(40);
const scouts = () => ScoutsResponse.parse({ revision: REV, now: '2026-09-27T08:50:02+02:00', scouts: [] });
const radar = () => RadarResponse.parse({
  revision: REV, now: '2026-09-30T10:00:00Z',
  sources: { dailyScout: { state: 'ok', count: 0 }, readingBriefs: { state: 'absent', count: 0 },
    importantUpdates: { state: 'absent', count: 0 }, explained: { state: 'absent', count: 0 } },
  papers: [], topics: [], decisions: [], applied: {}, appliedUpdatedAt: null, warnings: [],
});

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.mocked(getScouts).mockResolvedValue({ kind: 'ok', data: scouts() });
  vi.mocked(getRadar).mockResolvedValue({ kind: 'ok', data: radar() });
  vi.mocked(getScoutOutput).mockResolvedValue({ kind: 'offline' });
  vi.mocked(getRadarNote).mockResolvedValue({ kind: 'offline' });
  vi.mocked(postRadarDecision).mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
  dom.window.close();
});

it('mounts Research Radar on the full Scouts page for a signed-in account', async () => {
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: true, onOpen: () => {}, refreshKey: 0, accountKey: 'a'.repeat(64), blocked: false }));
  });
  expect(document.querySelector('section[aria-label="Research Radar"]')).not.toBeNull();
  await act(async () => root.unmount());
});

it('keeps Research Radar unmounted off the Scouts page and when signed out', async () => {
  let root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: false, onOpen: () => {}, refreshKey: 0, accountKey: 'a'.repeat(64), blocked: false }));
  });
  expect(document.querySelector('section[aria-label="Research Radar"]')).toBeNull();
  await act(async () => root.unmount());

  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: true, onOpen: () => {}, refreshKey: 0, accountKey: null, blocked: false }));
  });
  expect(document.querySelector('section[aria-label="Research Radar"]')).toBeNull();
  await act(async () => root.unmount());
});
