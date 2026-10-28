import { RingDayResponse } from '@vault-companion/contracts';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRingDay } from '../api.ts';
import { RingDaySheet } from './RingDaySheet.tsx';
vi.mock('../api.ts', () => ({ getRingDay: vi.fn() }));
const data = (status = 'ok') => RingDayResponse.parse({ revision: 'a'.repeat(40), now: '2026-10-20T12:00:00Z', today: '2026-10-20', date: '2026-10-20', status,
  dayStart: '2026-10-20T00:00:00+02:00', dayEnd: '2026-10-21T00:00:00+02:00', daySlots: 96, night: null, prevDate: '2026-10-18', nextDate: null,
  slots: [{ start: '2026-10-20T00:00:00+02:00', values: { hr: 50, hrMin: 45, hrMax: 55, steps: 0 } }, { start: '2026-10-20T00:15:00+02:00', values: { hr: 70, hrMin: 65, hrMax: 75 } }] });
let dom: JSDOM, root: Root;
beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>');
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { value, configurable: true });
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); dom.window.close(); vi.clearAllMocks(); });
async function render(status = 'ok') {
  vi.mocked(getRingDay).mockResolvedValue({ kind: 'ok', data: data(status) });
  await act(async () => root.render(createElement(RingDaySheet, { date: '2026-10-20', onClose: vi.fn() })));
}
it.each(['missing', 'unreadable'])('%s renders a plain status without charts', async status => {
  await render(status); expect(document.querySelectorAll('svg')).toHaveLength(0); expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
});
it('shows all registry values, unverified labels, latest strip values, night empties, and shared selection', async () => {
  await render(); expect(getRingDay).toHaveBeenCalledWith('2026-10-20');
  expect(document.querySelectorAll('[data-metric]')).toHaveLength(14);
  expect(document.querySelector('[data-metric="hr"] b')?.textContent).toBe('50 bpm');
  expect(document.querySelector('[data-metric="tempC"] b')?.textContent).toBe('—');
  for (const key of ['stress', 'fatigue', 'hrvMs']) expect(document.querySelector(`[data-metric="${key}"]`)?.textContent).toContain('(unverified)');
  expect(document.querySelector('.ring-tiles')?.textContent).toContain('—asleep');
  expect(document.querySelectorAll('polygon')).toHaveLength(1);
  expect(document.querySelectorAll('.ring-strip')[3]?.querySelector('rect')?.getAttribute('height')).toBe('0');
  expect(document.querySelectorAll('.ring-strip-heading')[1]?.textContent).toContain('70 bpm');
  const slider = document.querySelector('svg')!;
  await act(async () => { slider.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  expect(document.querySelector('[data-metric="hr"] b')?.textContent).toBe('70 bpm');
  expect([...document.querySelectorAll('svg')].every(s => s.getAttribute('aria-valuenow') === '1')).toBe(true);
  const next = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Next'))!; expect(next.disabled).toBe(true);
  await act(async () => { [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Sun 18'))!.click(); });
  expect(getRingDay).toHaveBeenLastCalledWith('2026-10-18');
});
it('maps a tap to an absent slot, showing em dashes for every metric', async () => {
  await render(); const slider = document.querySelector('svg')!;
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 96 } as DOMRect);
  await act(async () => { slider.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 2.5, bubbles: true })); });
  expect([...document.querySelectorAll('[data-metric] b')].every(b => b.textContent === '—')).toBe(true);
  expect(slider.getAttribute('aria-valuenow')).toBe('2');
});
it('renders daily night values and sleep stages, and breaks the min-max band at missing slots', async () => {
  const day = data(); day.night = { date: day.date, sleepStart: '2026-10-19T23:00:00+02:00', sleepEnd: '2026-10-20T06:00:00+02:00', lightMin: 300, deepMin: 120, awakeMin: 15, restingHr: 54, avgHr: null, minSpo2: null, avgSpo2: null, hrvSdnnMs: 41, bodyTempC: 36.2, hrN: 2, spo2N: 0, hrvN: 1, tempN: 1, sleepN: 2 };
  day.slots[0]!.values.sleepLightMin = 10; day.slots[0]!.values.sleepDeepMin = 5;
  day.slots.push({ start: '2026-10-20T01:00:00+02:00', values: { hr: 60, hrMin: 55, hrMax: 65 } });
  vi.mocked(getRingDay).mockResolvedValue({ kind: 'ok', data: day });
  await act(async () => root.render(createElement(RingDaySheet, { date: day.date, onClose: vi.fn() })));
  expect(document.querySelector('.ring-label')?.textContent).toBe('Night 23:00 – 06:00');
  expect(document.querySelector('.ring-tiles')?.textContent).toContain('7 h 0asleep54resting HR41 msHRV (unverified)2 h 0deep36.2°night temp3 / 96');
  expect(document.querySelector('.ring-strip')?.querySelectorAll('rect')).toHaveLength(2);
  expect(document.querySelectorAll('polygon')).toHaveLength(2);
});
