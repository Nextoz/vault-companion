import { ScoutsResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getScoutOutput, getScouts } from '../api.ts';
import { Scouts } from './Scouts.tsx';

vi.mock('../api.ts', () => ({ getScouts: vi.fn(), getScoutOutput: vi.fn() }));

const REV = 'a'.repeat(40);
const scouts = () => ScoutsResponse.parse({ revision: REV, now: '2026-09-27T08:50:02+02:00', scouts: [] });

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  vi.mocked(getScouts).mockResolvedValue({ kind: 'ok', data: scouts() });
  vi.mocked(getScoutOutput).mockResolvedValue({ kind: 'offline' });
});

afterEach(() => {
  dom.window.close();
});

const radarLink = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((button) => button.textContent === 'Research Radar');

it('links to Research Radar from the full Scouts page without mounting it inline (UX7)', async () => {
  const onOpenRadar = vi.fn();
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: true, onOpen: () => {}, refreshKey: 0, accountKey: 'a'.repeat(64), blocked: false, onOpenRadar }));
  });
  // Radar itself now lives on its own screen; the Scouts tab keeps only a small link.
  expect(document.querySelector('section[aria-label="Research Radar"]')).toBeNull();
  const link = radarLink();
  expect(link).not.toBeUndefined();
  await act(async () => { link!.click(); });
  expect(onOpenRadar).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('keeps the Radar link off the compact card and when signed out', async () => {
  let root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: false, onOpen: () => {}, refreshKey: 0, accountKey: 'a'.repeat(64), blocked: false, onOpenRadar: () => {} }));
  });
  expect(radarLink()).toBeUndefined();
  await act(async () => root.unmount());

  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(Scouts, { page: true, onOpen: () => {}, refreshKey: 0, accountKey: null, blocked: false, onOpenRadar: () => {} }));
  });
  expect(radarLink()).toBeUndefined();
  await act(async () => root.unmount());
});
