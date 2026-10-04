import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prefs } from '../prefs.ts';
import { SinceIWasHere } from './SinceIWasHere.tsx';
import type { SiwhFacts, SiwhTarget } from './since-i-was-here.ts';

const facts = (over: Partial<SiwhFacts> = {}): SiwhFacts => ({ triage: 0, scouts: [], brief: null, papers: [], health: null, ...over });

let dom: JSDOM;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  dom.window.close();
});

const render = async (value: SiwhFacts, onOpen: (target: SiwhTarget) => void = () => {}) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(createElement(SinceIWasHere, { facts: value, onOpen })); });
};

const lines = () => [...document.querySelectorAll('.siwh-line')];
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

describe('SinceIWasHere', () => {
  it('shows nothing on a first install and stores the baseline', async () => {
    await render(facts({ triage: 3, papers: [] }));
    expect(document.querySelector('.since-i-was-here')).toBeNull();
    expect(prefs.sinceIWasHereSnapshot()).toMatchObject({ triage: 3, papers: [] });
  });

  it('lists what is newer, then Dismiss all stores the snapshot and hides the pane', async () => {
    localStorage.setItem('vc.sinceIWasHere', JSON.stringify({ at: 1, triage: 0, scouts: { learning: 1 }, papers: [] }));
    await render(facts({ triage: 3, scouts: [{ id: 'learning', name: 'Learning', findings: 4 }], papers: ['a'] }));
    expect(lines().map((line) => line.textContent)).toEqual(['3 events in triage', 'Learning \u00b7 3 new findings', '1 new explained paper']);

    await act(async () => { (button('Dismiss all') as HTMLElement).click(); });
    expect(document.querySelector('.since-i-was-here')).toBeNull();
    expect(prefs.sinceIWasHereSnapshot()).toMatchObject({ triage: 3, scouts: { learning: 4 }, papers: ['a'] });
  });

  it('closes with the pane close button and opens the screen a line names', async () => {
    localStorage.setItem('vc.sinceIWasHere', JSON.stringify({ at: 1, triage: 0, health: '2026-09-29' }));
    const opened: string[] = [];
    await render(facts({ triage: 2, health: '2026-09-30' }), (target) => opened.push(target));
    expect(lines().map((line) => line.textContent)).toEqual(['2 events in triage', 'New health day']);
    await act(async () => { (lines()[0] as HTMLElement).click(); });
    expect(opened).toEqual(['triage']);
    await act(async () => { (button('\u00d7') as HTMLElement).click(); });
    expect(document.querySelector('.since-i-was-here')).toBeNull();
  });
});
