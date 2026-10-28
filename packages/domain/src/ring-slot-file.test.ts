import { expect, it } from 'vitest';
import { RING_METRICS, RING_SCHEMAS, ringSlotHeader } from './ring-metrics.ts';
import { mergeSlotFile, parseSlotFile } from './ring-slot-file.ts';
import { type RingSlot } from './ring-slots.ts';
const tz = 'Europe/Copenhagen', BOM = String.fromCharCode(0xfeff);
const slot = (start: string, hr: number | null = 72): RingSlot => ({ instant: Date.parse(start), values: { ...Object.fromEntries(RING_METRICS.map((m) => [m.key, null])), hr } as RingSlot['values'] });
const textOf = (result: ReturnType<typeof mergeSlotFile>) => { expect(result.ok).toBe(true); if (!result.ok) throw Error('refused'); return result.text; };
const row = (start: string, hr = '072') => [start, ...RING_METRICS.map((m) => m.key === 'hr' ? hr : '')].join(',');
it('creates, orders and deduplicates by instant, preserving both repeated DST hours', () => {
  const a = slot('2026-10-25T02:15:00+02:00'), b = slot('2026-10-25T02:15:00+01:00');
  const text = textOf(mergeSlotFile(null, [b, a], 1, tz));
  expect(text).toBe(`${ringSlotHeader(1)}\n${row('2026-10-25T02:15:00+02:00', '72')}\n${row('2026-10-25T02:15:00+01:00', '72')}\n`);
  expect(mergeSlotFile(text, [slot('2026-10-25T01:15:00Z')], 1, tz)).toEqual({ ok: true, text, changed: false });
  expect(parseSlotFile(text)).toMatchObject({ ok: true, slots: [a, b] });
});
it('never erases, never rewrites equal values and preserves BOM, CRLF and untouched bytes', () => {
  const start = '2026-10-10T12:00:00+02:00', next = '2026-10-10T12:15:00+02:00';
  const text = `${BOM}${ringSlotHeader(1)}\r\n${row(start)}\r\n${row(next)}\r\n`;
  for (const hr of [null, 72]) expect(mergeSlotFile(text, [slot(start, hr)], 1, tz)).toEqual({ ok: true, text, changed: false });
  const updated = textOf(mergeSlotFile(text, [slot(start, 73)], 1, tz));
  expect(updated).toBe(text.replace(row(start), row(start, '73')));
  expect(mergeSlotFile(updated, [slot(start, 73)], 1, tz)).toEqual({ ok: true, text: updated, changed: false });
  const other = slot(start, null); other.values.spo2 = 97;
  expect(textOf(mergeSlotFile(text, [other], 1, tz))).toBe(text.replace(row(start), row(start, '72').replace(/,,,,/, ',,,97,')));
});
it('retains existing row order, mixed terminators and absent final newline on insert', () => {
  const a = '2026-10-10T12:00:00+02:00', b = '2026-10-10T12:15:00+02:00', c = '2026-10-10T12:30:00+02:00';
  const text = `${ringSlotHeader(1)}\r\n${row(a)}\n${row(c)}`;
  expect(textOf(mergeSlotFile(text, [slot(b)], 1, tz))).toBe(`${ringSlotHeader(1)}\r\n${row(a)}\n${row(b, '72')}\r\n${row(c)}`);
  const reversed = `${ringSlotHeader(1)}\n${row(c)}\n${row(a)}`;
  expect(textOf(mergeSlotFile(reversed, [slot(a, 73)], 1, tz))).toBe(reversed.replace(row(a), row(a, '73')));
  expect(textOf(mergeSlotFile(ringSlotHeader(1), [slot(a)], 1, tz))).toBe(`${ringSlotHeader(1)}\n${row(a, '72')}`);
});
it('formats registry cells with plain integers, shortest decimals and empty nulls', () => {
  const s = slot('2026-10-10T10:00:00Z'); s.values.tempC = 36.20; s.values.steps = 987;
  const text = textOf(mergeSlotFile(null, [s], 1, tz));
  expect(text.split('\n')[1]).toBe(['2026-10-10T12:00:00+02:00', ...RING_METRICS.map((m) => m.key === 'tempC' ? '36.2' : m.key === 'steps' ? '987' : m.key === 'hr' ? '72' : '')].join(','));
  expect(mergeSlotFile(text, [], 987, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
});
const bad = (cell: string, start = '2026-10-10T12:00:00+02:00') => `${ringSlotHeader(1)}\n${row(start, cell)}`;
it.each([
  '', 'wrong', ringSlotHeader(1).replace(',', `,${BOM}`), `${ringSlotHeader(1)}\ninvalid`, `${ringSlotHeader(1)}\n${row('2026-10-10T12:00:00+02:00')}\n\n`,
  bad('72', '2026-02-30T12:00:00+01:00'), bad('72', '2026-10-10T12:00:00+02:07'), bad('72', '2026-10-10T12:00:00'), bad('72', '2026-10-10T12:00:00.000+02:00'),
  ...['-1', 'NaN', '1.5', '72.0', ' 72', '1e2'].map((v) => bad(v)),
])('refuses malformed storage privately (%#)', (text) => {
  expect(parseSlotFile(text)).toMatchObject({ ok: false, code: 'refused:structure' });
  expect(mergeSlotFile(text, [slot('2026-10-10T12:00:00+02:00', 99)], 1, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
});
it('refuses duplicate instants, bad cell counts, invalid sleep sums and excess decimal precision', () => {
  const raw = row('2026-10-10T12:00:00+02:00');
  const cells = raw.split(',');
  const at = (key: string) => 1 + RING_METRICS.findIndex((m) => m.key === key);
  for (const patch of [{ sleepLightMin: '16' }, { sleepLightMin: '8', sleepDeepMin: '8' }, { tempC: '1.123' }]) {
    const bad = [...cells]; for (const [key, value] of Object.entries(patch)) bad[at(key)] = value;
    expect(parseSlotFile(`${ringSlotHeader(1)}\n${bad.join(',')}`)).toMatchObject({ ok: false });
  }
  const sameInstant = row('2026-10-10T10:00:00Z');
  for (const body of [`${raw}\n${raw}`, `${raw}\n${sameInstant}`, `${raw},`, raw.replace(':00:00+', ':07:00+')]) expect(parseSlotFile(`${ringSlotHeader(1)}\n${body}`)).toMatchObject({ ok: false });
});
it('refuses partial sleep merges whose combined stage minutes exceed fifteen', () => {
  const stored = slot('2026-10-10T12:00:00+02:00', null), sent = slot('2026-10-10T12:00:00+02:00', null);
  stored.values.sleepLightMin = 8; sent.values.sleepDeepMin = 8;
  const existing = textOf(mergeSlotFile(null, [stored], 1, tz));
  expect(parseSlotFile(textOf(mergeSlotFile(null, [sent], 1, tz)))).toMatchObject({ ok: true });
  expect(mergeSlotFile(existing, [sent], 1, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
});
it('upgrades a known old header once, on the first write that changes a value, after a registry schema bump', () => {
  const metric = RING_METRICS.at(-1)!, oldSince = metric.since;
  const schemas = RING_SCHEMAS as Record<string, number>;
  // Simulate an appended metric introduced in v2 without introducing production schema v2.
  metric.since = 2; schemas['ring-slots/2'] = 2;
  try {
    const start = '2026-10-10T12:00:00+02:00', raw = row(start).slice(0, -1), old = `${BOM}${ringSlotHeader(1)}\r\n${raw}`;
    const resend = slot(start, 72); resend.values[metric.key] = 5;
    expect(mergeSlotFile(old, [resend], 1, tz)).toEqual({ ok: true, text: old, changed: false });
    const added = '2026-10-10T12:15:00+02:00', text = textOf(mergeSlotFile(old, [slot(added, 70)], 1, tz));
    expect(text).toBe(`${BOM}${ringSlotHeader(2)}\r\n${raw},\r\n${row(added, '70')}`);
    expect(mergeSlotFile(text, [slot(added, 70)], 1, tz)).toEqual({ ok: true, text, changed: false });
    expect(textOf(mergeSlotFile(text, [resend], 2, tz))).toBe(text.replace(`${raw},`, `${row(start, '72')}5`));
  } finally { metric.since = oldSince; delete schemas['ring-slots/2']; }
});
