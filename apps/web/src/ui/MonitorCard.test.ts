import { JSDOM } from 'jsdom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorCard } from './MonitorCard.tsx';

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

const card = (overrides: Partial<Parameters<typeof MonitorCard>[0]>) =>
  createElement(MonitorCard, {
    title: 'AI usage',
    summary: createElement('p', null, 'the summary'),
    children: createElement('div', null, 'the body'),
    ...overrides,
  });
const renderTree = async (node: ReactNode) => {
  root = createRoot(document.getElementById('root')!);
  await act(async () => { root!.render(node); });
};
const render = async (overrides: Partial<Parameters<typeof MonitorCard>[0]> = {}) => renderTree(card(overrides));
const text = () => document.getElementById('root')!.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)!;
const toggle = async (label = 'AI usage') => { await act(async () => { (button(label) as HTMLElement).click(); }); };

describe('MonitorCard', () => {
  it('starts collapsed: the summary shows, the body does not, and the head button controls the body id', async () => {
    await render();
    const section = document.querySelector('section')!;
    expect(section.className).toContain('dash-card');
    expect(section.className).toContain('monitor');
    const heading = document.getElementById(section.getAttribute('aria-labelledby')!)!;
    expect(heading.tagName).toBe('H2');
    const head = button('AI usage');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.className).toBe('monitor-head');
    const body = document.getElementById(head.getAttribute('aria-controls')!)!;
    expect(body.className).toBe('monitor-body');
    expect(body.textContent).toContain('the summary');
    expect(text()).not.toContain('the body');
  });

  it('clicking the head shows the body and the headerExtra, hides the summary; clicking again collapses', async () => {
    await render({ headerExtra: createElement('div', null, 'the extra') });
    expect(text()).not.toContain('the extra');
    const head = button('AI usage');
    await act(async () => { (head as HTMLElement).click(); });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('the extra');
    expect(text()).toContain('the body');
    expect(text()).not.toContain('the summary');
    await act(async () => { (head as HTMLElement).click(); });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(text()).toContain('the summary');
    expect(text()).not.toContain('the extra');
  });

  it('a status replaces the summary and the body in both states; the footer shows in both states', async () => {
    await render({ status: createElement('p', null, 'the status'), footer: createElement('p', null, 'the footer') });
    expect(text()).toContain('the status');
    expect(text()).toContain('the footer');
    expect(text()).not.toContain('the summary');
    await toggle();
    expect(text()).toContain('the status');
    expect(text()).not.toContain('the body');
    expect(text()).toContain('the footer');
  });

  it('one failing monitor shows its own apology note and its neighbour keeps drawing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Boom(): ReactNode { throw new Error('this monitor threw while rendering'); }
    await renderTree(createElement('div', null,
      card({ title: 'First', summary: createElement('p', null, 'first summary'), children: createElement(Boom) }),
      card({ title: 'Second', summary: createElement('p', null, 'neighbour summary'), children: createElement('div', null, 'neighbour body') })));
    await toggle('First'); // Boom throws while expanding: only that card falls back.
    expect(text()).toContain('First could not be shown.');
    expect(text()).not.toContain('first summary');
    expect(text()).toContain('neighbour summary');
    consoleError.mockRestore();
  });
});
