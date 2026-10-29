import { PHONE_METRICS, PHONE_SCHEMAS, phoneSlotHeader, type PhoneMetric } from './phone-metrics.ts';
import { ringFileLines, ringFileHeader, joinRingLines, firstEol, type RingFileLine } from './ring-slot-file.ts';
import type { PhoneSlot } from './phone-slots.ts';
import { canonicalSlotStart } from './ring-slots.ts';

export const phoneStructureRefusal = { ok: false, code: 'refused:structure', message: 'phone file has an unexpected structure' } as const;
export type PhoneFileMerge = { ok: true; text: string; changed: boolean } | typeof phoneStructureRefusal;
const BOM = String.fromCharCode(0xfeff);
const SLOT_MS = 15 * 60_000;
const STORED_START = /^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45):00(?:Z|[+-]\d{2}:\d{2})$/;

const metricsOf = (version: number) => PHONE_METRICS.filter((m) => m.since <= version);
const latestVersion = () => Math.max(...Object.values(PHONE_SCHEMAS));
function emptyValues(): PhoneSlot['values'] {
  const values = {} as PhoneSlot['values'];
  for (const m of PHONE_METRICS) for (const column of m.columns) values[column] = null;
  return values;
}

/** A stored `slot_start`: ISO with offset, a real calendar date, on a 15-minute boundary; else null. */
function parseStoredStart(start: string): number | null {
  const instant = Date.parse(start);
  if (!STORED_START.test(start) || !Number.isFinite(instant) || instant % SLOT_MS !== 0) return null;
  // Date.parse normalizes invalid calendar dates (02-30); reject those rather than repair them.
  return new Date(`${start.slice(0, 19)}Z`).toISOString().slice(0, 19) === start.slice(0, 19) ? instant : null;
}
/** A stored cell: '' is null; otherwise plain digits (no sign, exponent or spaces) obeying the registry rule. */
function parseStoredCell(cell: string, metric: PhoneMetric): number | null | undefined {
  if (cell === '') return null;
  const digits = metric.value.kind === 'int' ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  const value = Number(cell), rule = metric.value;
  return digits.test(cell) && Number.isFinite(value) && value >= rule.min
    && value * 10 ** rule.decimals <= Number.MAX_SAFE_INTEGER
    && (rule.max === undefined || value <= rule.max)
    && Number(value.toFixed(rule.decimals)) === value ? value : undefined;
}
const columnsOf = (metrics: readonly PhoneMetric[]) => metrics.flatMap((m) => m.columns.map((column, i) => ({ column, metric: i === 0 ? m : { ...m, value: { kind: 'decimal' as const, decimals: 1, min: 0 as const, max: 15 } } })));
function parseStoredRow(raw: string, metrics: readonly PhoneMetric[]): PhoneSlot | null {
  const [start = '', ...cells] = raw.split(','), instant = parseStoredStart(start), columns = columnsOf(metrics);
  if (instant === null || cells.length !== columns.length) return null;
  const values = emptyValues();
  for (const [i, { column, metric }] of columns.entries()) {
    const value = parseStoredCell(cells[i]!, metric);
    if (value === undefined || (metric.slot === 'union-min' && value !== null && value > 15)) return null;
    values[column] = value;
  }
  return { instant, values };
}
/** Copy the sent non-null values that differ; null never erases. Returns whether anything changed. */
function applySent(stored: PhoneSlot, sent: PhoneSlot, metrics: readonly PhoneMetric[], mode: 'replace' | 'fill'): boolean {
  let changed = false;
  for (const { column: key } of columnsOf(metrics)) {
    const value = sent.values[key];
    if (value == null || value === stored.values[key] || (mode === 'fill' && stored.values[key] != null)) continue;
    stored.values[key] = value; changed = true;
  }
  return changed;
}
export function mergePhoneSlotFile(existing: string | null, slots: readonly PhoneSlot[], version: number, tz: string, mode: 'replace' | 'fill' = 'replace'): PhoneFileMerge {
  if (!Object.values(PHONE_SCHEMAS).includes(version)) return phoneStructureRefusal;
  const target = latestVersion(), metrics = metricsOf(target), sentMetrics = metricsOf(version);
  const lines = ringFileLines(existing ?? `${phoneSlotHeader(target)}\n`), eol = firstEol(lines), final = lines.at(-1)?.end ?? '';
  const storedVersion = Object.values(PHONE_SCHEMAS).find((v) => phoneSlotHeader(v) === ringFileHeader(lines));
  if (storedVersion === undefined) return phoneStructureRefusal;
  const storedMetrics = metricsOf(storedVersion);
  const rows = new Map<number, RingFileLine & { instant: number; slot?: PhoneSlot; updated?: boolean }>();
  for (const line of lines.slice(1)) {
    const instant = parseStoredStart(line.raw.slice(0, line.raw.indexOf(',')));
    if (instant === null || rows.has(instant)) return phoneStructureRefusal;
    rows.set(instant, { ...line, instant });
  }
  const format = (slot: PhoneSlot) => [canonicalSlotStart(slot.instant, tz), ...columnsOf(metrics).map(({ column }) => slot.values[column] ?? '')].join(',');
  const originals = [...rows.values()];
  const added: (RingFileLine & { instant: number })[] = [];
  let changed = existing === null;
  for (const sent of [...slots].sort((a, b) => a.instant - b.instant)) {
    const row = rows.get(sent.instant);
    if (row) {
      // Validate even an identical resend's touched row before deciding it is unchanged.
      const stored = row.slot ?? parseStoredRow(row.raw, storedMetrics);
      if (!stored) return phoneStructureRefusal;
      row.slot = stored;
      if (!applySent(stored, sent, sentMetrics, mode)) continue;
      const raw = format(stored);
      if (!parseStoredRow(raw, metrics)) return phoneStructureRefusal;
      row.raw = raw; row.updated = true; changed = true;
    } else {
      const slot = { instant: sent.instant, values: emptyValues() };
      applySent(slot, sent, sentMetrics, mode);
      const raw = format(slot);
      if (!parseStoredRow(raw, metrics)) return phoneStructureRefusal;
      const row = { instant: sent.instant, slot, raw, end: eol };
      rows.set(sent.instant, row); added.push(row); changed = true;
    }
  }
  if (!changed) return { ok: true, text: existing!, changed: false };
  if (storedVersion < target) {
    lines[0]!.raw = `${lines[0]!.raw.startsWith(BOM) ? BOM : ''}${phoneSlotHeader(target)}`;
    for (const row of originals) if (!row.updated) {
      // A schema bump rewrites these rows too: validate before appending columns.
      if (!parseStoredRow(row.raw, storedMetrics)) return phoneStructureRefusal;
      row.raw += ','.repeat(columnsOf(metrics).length - columnsOf(storedMetrics).length);
    }
  }
  // Preserve even unsorted existing order: insert before the first greater stored instant.
  const merged: RingFileLine[] = [lines[0]!];
  let next = 0;
  for (const row of originals) {
    while (next < added.length && added[next]!.instant < row.instant) merged.push(added[next++]!);
    merged.push(row);
  }
  merged.push(...added.slice(next));
  const text = joinRingLines(merged, eol, final);
  return { ok: true, text, changed: text !== existing };
}
