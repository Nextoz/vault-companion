import { expect, it } from 'vitest';
import { PHONE_METRICS, PHONE_SCHEMAS, phoneSlotHeader, type PhoneMetric } from './phone-metrics.ts';
import { mergePhoneSlotFile } from './phone-slot-file.ts';
import type { PhoneSlot } from './phone-slots.ts';
const tz = 'Europe/Copenhagen', BOM = '\uFEFF';
const a = '2026-10-10T12:00:00+02:00', b = '2026-10-10T12:15:00+02:00';
const columns = () => PHONE_METRICS.flatMap((m) => [...m.columns]);
const slot = (start: string, patch: Record<string, number | null> = { steps: 72 }): PhoneSlot =>
  ({ instant: Date.parse(start), values: { ...Object.fromEntries(columns().map((c) => [c, null])), ...patch } });
const row = (start: string, patch: Record<string, string> = { steps: '072' }, version = Infinity) =>
  [start, ...PHONE_METRICS.filter((m) => m.since <= version).flatMap((m) => m.columns.map((c) => patch[c] ?? ''))].join(',');
const textOf = (result: ReturnType<typeof mergePhoneSlotFile>) => {
  expect(result.ok).toBe(true); if (!result.ok) throw Error('refused'); return result.text;
};
it('creates sorted rows for both repeated DST hours and resends without changes', () => {
  const early = '2026-10-25T02:15:00+02:00', late = '2026-10-25T02:15:00+01:00';
  const slots = [slot(late), slot(early)], text = textOf(mergePhoneSlotFile(null, slots, 1, tz));
  expect(text).toBe(`${phoneSlotHeader(1)}\n${row(early, { steps: '72' })}\n${row(late, { steps: '72' })}\n`);
  expect(mergePhoneSlotFile(text, slots, 1, tz)).toEqual({ ok: true, text, changed: false });
});
it('preserves unchanged cells and neighbouring bytes including BOM, CRLF, offsets and leading zeros', () => {
  const text = `${BOM}${phoneSlotHeader(1)}\r\n${row(a)}\r\n${row('2026-10-10T10:15:00Z')}\r\n`;
  for (const steps of [null, 72]) expect(mergePhoneSlotFile(text, [slot(a, { steps })], 1, tz)).toEqual({ ok: true, text, changed: false });
  const changed = textOf(mergePhoneSlotFile(text, [slot(a, { steps: 73 })], 1, tz));
  expect(changed).toBe(text.replace(row(a), row(a, { steps: '73' })));
  expect(mergePhoneSlotFile(changed, [slot(a, { steps: 73 })], 1, tz)).toEqual({ ok: true, text: changed, changed: false });
});
it('fill keeps a stored nonempty cell while filling empty cells', () => {
  const text = `${phoneSlotHeader(1)}\n${row(a)}\n`;
  const filled = textOf(mergePhoneSlotFile(text, [slot(a, { steps: 99, distance_km: 1.234 })], 1, tz, 'fill'));
  expect(filled).toBe(`${phoneSlotHeader(1)}\n${row(a, { steps: '72', distance_km: '1.234' })}\n`);
  expect(mergePhoneSlotFile(filled, [slot(a, { steps: 99, distance_km: 9 })], 1, tz, 'fill')).toEqual({ ok: true, text: filled, changed: false });
  expect(textOf(mergePhoneSlotFile(text, [slot(a, { steps: 99 })], 1, tz, 'replace'))).toContain(row(a, { steps: '99' }));
});
it('reads headphone-minute precision from registry metadata and retains the slot duration cap', () => {
  const metric = PHONE_METRICS.find((m) => m.key === 'headphone')! as PhoneMetric;
  const rule = metric.daily.find((d) => d.column === 'headphone_min')!, decimals = rule.decimals;
  rule.decimals = 2;
  try {
    expect(textOf(mergePhoneSlotFile(null, [slot(a, { headphone_min: 1.23 })], 1, tz))).toContain(row(a, { headphone_min: '1.23' }));
    for (const headphone_min of [1.234, 15.01]) {
      expect(mergePhoneSlotFile(null, [slot(a, { headphone_min })], 1, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
    }
  } finally { rule.decimals = decimals; }
});
it('upgrades a known old header only on a changing write, once', () => {
  const metric = PHONE_METRICS.at(-1)! as PhoneMetric, oldSince = metric.since, schemas = PHONE_SCHEMAS as Record<string, number>;
  metric.since = 2; schemas['phone-slots/2'] = 2;
  try {
    const old = `${BOM}${phoneSlotHeader(1)}\r\n${row(a, { steps: '072' }, 1)}`;
    expect(mergePhoneSlotFile(old, [slot(a)], 1, tz)).toEqual({ ok: true, text: old, changed: false });
    expect(mergePhoneSlotFile(old, [slot(a, { in_bed_min: 5 })], 1, tz)).toEqual({ ok: true, text: old, changed: false });
    const upgraded = textOf(mergePhoneSlotFile(old, [slot(b)], 1, tz));
    expect(upgraded).toBe(`${BOM}${phoneSlotHeader(2)}\r\n${row(a)}\r\n${row(b, { steps: '72' })}`);
    expect(mergePhoneSlotFile(upgraded, [slot(b)], 1, tz)).toEqual({ ok: true, text: upgraded, changed: false });
    expect(textOf(mergePhoneSlotFile(upgraded, [slot(a, { in_bed_min: 5 })], 2, tz))).toContain(row(a, { steps: '72', in_bed_min: '5' }));
  } finally { metric.since = oldSince; delete schemas['phone-slots/2']; }
});
it('refuses unknown headers, schemas and malformed touched rows', () => {
  const badRows = [row(a, { steps: '-1' }), row(a, { steps: '1.5' }), row(a, { distance_km: '1.2345' }), row(a, { in_bed_min: '16' }), `${row(a)},`, 'invalid'];
  for (const text of ['wrong', '', `${phoneSlotHeader(1)},unknown\n${row(a)}`, ...badRows.map((raw) => `${phoneSlotHeader(1)}\n${raw}`)]) {
    expect(mergePhoneSlotFile(text, [slot(a)], 1, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
  }
  expect(mergePhoneSlotFile(null, [slot(a)], 99, tz)).toMatchObject({ ok: false, code: 'refused:structure' });
});
