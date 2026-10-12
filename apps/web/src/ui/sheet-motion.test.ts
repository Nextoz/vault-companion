// R2 review: the exit's guard paths. Motion is stubbed so each test decides when the slide-out "ends".
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const motion = vi.hoisted(() => ({ reduced: false, plays: [] as { frames: Keyframe[]; end: () => void }[] }));
vi.mock('./motion.ts', () => ({
  prefersReducedMotion: () => motion.reduced,
  duration: () => 280,
  easing: () => 'linear',
  play: (_el: Element, frames: Keyframe[]) => {
    let end = () => {};
    const done = new Promise<void>((resolve) => { end = resolve; });
    motion.plays.push({ frames, end });
    return { animation: { cancel() {}, finish() {} } as unknown as Animation, done };
  },
}));

import { SheetHeader } from './SheetHeader.tsx';

let dom: JSDOM;
let root: Root;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, 'Element', { value: dom.window.Element, configurable: true });
  Object.defineProperty(globalThis, 'getComputedStyle', { value: dom.window.getComputedStyle.bind(dom.window), configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  motion.reduced = false;
  motion.plays = [];
  root = createRoot(document.getElementById('root')!);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const render = async (props: { onClose: () => void; disabled?: boolean }) => {
  await act(async () => {
    root.render(createElement('div', { className: 'sheet-backdrop' },
      createElement('div', { className: 'sheet' }, createElement(SheetHeader, { title: 'Edit task', closeLabel: 'Cancel', ...props }),
        createElement('button', { type: 'button' }, 'Save'))));
  });
};
const sheet = () => document.querySelector<HTMLElement>('.sheet')!;
const closeButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!;
const endExit = async () => { await act(async () => { motion.plays.forEach((p) => p.end()); await Promise.resolve(); }); };

describe('the sheet exit', () => {
  it('is inert while it leaves, and a refused close (sheet still mounted) brings it back, interactive', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => closeButton().click());
    expect(sheet().inert).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    await endExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheet().inert).toBe(false);
    // Springs back from off-screen.
    expect(motion.plays.some((p) => p.frames[0]?.transform === 'translate3d(0, 100%, 0)')).toBe(true);
  });

  it('does not close when the caller became busy (disabled) during the exit; it comes back instead', async () => {
    const onClose = vi.fn();
    await render({ onClose });
    await act(async () => closeButton().click());
    await render({ onClose, disabled: true });
    await endExit();
    expect(onClose).not.toHaveBeenCalled();
    expect(sheet().inert).toBe(false);
  });

  it('calls the latest onClose, not the one captured at the tap', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    await render({ onClose: first });
    await act(async () => closeButton().click());
    await render({ onClose: latest });
    await endExit();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('under reduced motion, a tap on the header title plays nothing (no blink)', async () => {
    motion.reduced = true;
    await render({ onClose: vi.fn() });
    const title = document.querySelector('.sheet-header h2')!;
    const pointer = (type: string) => Object.assign(new dom.window.Event(type, { bubbles: true }), { pointerId: 1, isPrimary: true, button: 0, clientY: 40 });
    await act(async () => { title.dispatchEvent(pointer('pointerdown')); title.dispatchEvent(pointer('pointerup')); });
    expect(motion.plays).toEqual([]);
  });
});
