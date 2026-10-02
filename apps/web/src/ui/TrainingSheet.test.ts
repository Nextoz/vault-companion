import { TrainingResponse, type TrainingRow } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTraining } from '../api.ts';
import type { PendingQueue } from '../queue/queue.ts';
import { parseDecimal, TrainingSheet } from './TrainingSheet.tsx';

vi.mock('../api.ts', () => ({ getTraining: vi.fn() }));

let dom: JSDOM;
// Imported after the JSDOM globals exist, so React sees a browser and wires controlled inputs to native `input`.
let createRoot: typeof import('react-dom/client').createRoot;

beforeEach(async () => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/' });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  ({ createRoot } = await import('react-dom/client'));
  vi.mocked(getTraining).mockResolvedValue({ kind: 'ok', data: TrainingResponse.parse({
    status: 'ok', revision: '1'.repeat(40), blobSha: '2'.repeat(40), unknownLines: [],
    rows: [{ date: '2026-09-20', time: '08:00', type: 'Gym', distance: '', duration: '45', weight: '', split: 'Group: Functional Express', note: '' }],
  }) });
});

afterEach(() => { dom.window.close(); vi.clearAllMocks(); });

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const label = (text: string) => [...document.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text));
const inputOf = (text: string) => label(text)!.querySelector('input')!;

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const select = el instanceof dom.window.HTMLSelectElement;
  const proto = select ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  await act(async () => { el.dispatchEvent(new dom.window.Event(select ? 'change' : 'input', { bubbles: true })); });
}

async function mount(edit?: { row: TrainingRow }) {
  const enqueue = vi.fn().mockResolvedValue('enqueued');
  const queue = { enqueue } as unknown as PendingQueue;
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(createElement(TrainingSheet, { queue, accountKey: 'a'.repeat(64), baseRevision: '1'.repeat(40), onClose: () => {}, ...(edit ? { edit } : {}) })); });
  return { root, enqueue };
}

describe('parseDecimal (B1)', () => {
  it('accepts a dot or a Danish comma with at most one decimal', () => {
    expect(parseDecimal('84.5')).toBe(84.5);
    expect(parseDecimal('84,5')).toBe(84.5);
    expect(parseDecimal(' 84 ')).toBe(84);
    expect(parseDecimal('5,2')).toBe(5.2);
  });
  it('refuses anything else', () => {
    for (const t of ['', '84.55', '84,', ',5', '1,234', '84.5 kg', '-3', '1e2', '84 5']) expect(parseDecimal(t)).toBeNaN();
  });
});

describe('Group training (B11)', () => {
  it('shows a required Class name with cached suggestions only for the Group workout', async () => {
    const { root, enqueue } = await mount();
    expect(label('Workout')!.querySelector('select')!.textContent).toContain('Group training');
    expect(label('Class name')).toBeUndefined();

    await setValue(label('Workout')!.querySelector('select')!, 'Group');
    const className = inputOf('Class name');
    expect(className.value).toBe('');
    expect(button('Functional Express')!.textContent).toBe('Functional Express');
    await setValue(inputOf('Duration (min)'), '45');
    expect(button('Save')!.disabled).toBe(true);

    await act(async () => { button('Functional Express')!.click(); });
    expect(className.value).toBe('Functional Express');
    expect(button('Save')!.disabled).toBe(false);
    await act(async () => { button('Save')!.click(); });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [envelope] = enqueue.mock.calls[0]!;
    expect(envelope.payload.session).toMatchObject({ type: 'Gym', split: 'Group', className: 'Functional Express', duration: 45 });
    await act(async () => root.unmount());
  });

  it('leaves other splits without a class name input or suggestions', async () => {
    const { root } = await mount();
    await setValue(label('Workout')!.querySelector('select')!, 'Legs');
    expect(label('Class name')).toBeUndefined();
    expect(button('Functional Express')).toBeUndefined();
    await act(async () => root.unmount());
  });
});

describe('edit mode (B12)', () => {
  it('keeps an edited row’s empty time empty and waits for one before saving', async () => {
    const { root } = await mount({ row: { date: '2026-09-20', time: '', type: 'Run', distance: '5.2 km', duration: '45 min', weight: '', split: '', note: '' } });
    expect(inputOf('When').value).toBe('');
    expect(button('Save changes')!.disabled).toBe(true);
    await setValue(inputOf('When'), '2026-09-20T08:00');
    expect(button('Save changes')!.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it('leaves an unknown split unselected, shows an unreadable weight, and waits for both', async () => {
    const { root } = await mount({ row: { date: '2026-09-20', time: '08:00', type: 'Gym', distance: '', duration: '45', weight: 'heavy', split: 'Push', note: '' } });
    expect(button('Save changes')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Was: heavy');
    await setValue(label('Workout')!.querySelector('select')!, 'Bicep');
    await setValue(inputOf('Weight (kg, optional)'), '80');
    expect(button('Save changes')!.disabled).toBe(false);
    await act(async () => root.unmount());
  });
});
