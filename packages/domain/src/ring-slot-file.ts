import { RING_METRICS, RING_SCHEMAS, ringSlotHeader, ringValueValid, type RingMetric } from './ring-metrics.ts';
import { canonicalSlotStart, type RingSlot } from './ring-slots.ts';

export const ringStructureRefusal = { ok: false, code: 'refused:structure', message: 'ring file has an unexpected structure' } as const;
export type RingFileMerge = { ok: true; text: string; changed: boolean } | typeof ringStructureRefusal;
export type RingFileLine = { raw: string; end: string };
const BOM = String.fromCharCode(0xfeff);
const SLOT_MS = 15 * 60_000;
const STORED_START = /^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45):00(?:Z|[+-]\d{2}:\d{2})$/;

// Retain each line's terminator, including mixed EOLs and an absent final newline. '' has no lines.
export function ringFileLines(text: string): RingFileLine[] {
  return [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter((m) => m[0] !== '').map((m) => ({ raw: m[1]!, end: m[2]! }));
}
/** The header line without a BOM; undefined for an empty file (which is refused, never repaired). */
export function ringFileHeader(lines: readonly RingFileLine[]): string | undefined {
  const raw = lines[0]?.raw;
  return raw?.startsWith(BOM) ? raw.slice(1) : raw;
}
/** Join lines: a line without a terminator gets `eol`, except the last, which keeps the file's final terminator. */
export function joinRingLines(lines: readonly RingFileLine[], eol: string, final: string): string {
  return lines.map((l, i) => l.raw + (i === lines.length - 1 ? final : l.end || eol)).join('');
}
export const firstEol = (lines: readonly RingFileLine[]): string => lines.find((l) => l.end)?.end ?? '\n';
const metricsOf = (version: number) => RING_METRICS.filter((m) => m.since <= version);
const latestVersion = () => Math.max(...Object.values(RING_SCHEMAS));
const emptyValues = () => Object.fromEntries(RING_METRICS.map((m) => [m.key, null])) as RingSlot['values'];

/** A stored `slot_start`: ISO with offset, a real calendar date, on a 15-minute boundary; else null. */
function parseStoredStart(start: string): number | null {
  const instant = Date.parse(start);
  if (!STORED_START.test(start) || !Number.isFinite(instant) || instant % SLOT_MS !== 0) return null;
  // Date.parse normalizes invalid calendar dates (02-30); reject those rather than repair them.
  return new Date(`${start.slice(0, 19)}Z`).toISOString().slice(0, 19) === start.slice(0, 19) ? instant : null;
}
/** A stored cell: '' is null; otherwise plain digits (no sign, exponent or spaces) obeying the registry rule. */
function parseStoredCell(cell: string, metric: RingMetric): number | null | undefined {
  if (cell === '') return null;
  const digits = metric.value.kind === 'int' ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  return digits.test(cell) && ringValueValid(metric.value, Number(cell)) ? Number(cell) : undefined;
}
function parseStoredRow(raw: string, metrics: readonly RingMetric[]): RingSlot | null {
  const [start = '', ...cells] = raw.split(','), instant = parseStoredStart(start);
  if (instant === null || cells.length !== metrics.length) return null;
  const values = emptyValues(), sums = new Map<string, number>();
  for (const [i, m] of metrics.entries()) {
    const value = parseStoredCell(cells[i]!, m);
    if (value === undefined) return null;
    values[m.key] = value;
    if (!m.sumGroup) continue;
    const sum = (sums.get(m.sumGroup.id) ?? 0) + (value ?? 0);
    if (sum > m.sumGroup.max) return null;
    sums.set(m.sumGroup.id, sum);
  }
  return { instant, values };
}
export function parseSlotFile(text: string): { ok: true; version: number; slots: RingSlot[] } | typeof ringStructureRefusal {
  const lines = ringFileLines(text), header = ringFileHeader(lines);
  const version = Object.values(RING_SCHEMAS).find((v) => ringSlotHeader(v) === header);
  if (version === undefined) return ringStructureRefusal;
  const metrics = metricsOf(version), slots: RingSlot[] = [], seen = new Set<number>();
  for (const { raw } of lines.slice(1)) {
    const slot = parseStoredRow(raw, metrics);
    if (!slot || seen.has(slot.instant)) return ringStructureRefusal;
    seen.add(slot.instant); slots.push(slot);
  }
  return { ok: true, version, slots };
}
/** Copy the sent non-null values that differ; null never erases. Returns whether anything changed. */
function applySent(stored: RingSlot, sent: RingSlot, metrics: readonly RingMetric[]): boolean {
  let changed = false;
  for (const { key } of metrics) {
    const value = sent.values[key];
    if (value == null || value === stored.values[key]) continue;
    stored.values[key] = value; changed = true;
  }
  return changed;
}
export function mergeSlotFile(existing: string | null, slots: readonly RingSlot[], version: number, tz: string): RingFileMerge {
  if (!Object.values(RING_SCHEMAS).includes(version)) return ringStructureRefusal;
  const target = latestVersion(), metrics = metricsOf(target), sentMetrics = metricsOf(version);
  const parsed = existing === null ? { ok: true as const, version: target, slots: [] as RingSlot[] } : parseSlotFile(existing);
  if (!parsed.ok) return parsed;
  const lines = ringFileLines(existing ?? `${ringSlotHeader(target)}\n`), eol = firstEol(lines), final = lines.at(-1)!.end;
  const rows = parsed.slots.map((slot, i) => ({ slot, ...lines[i + 1]! }));
  const format = (slot: RingSlot) => [canonicalSlotStart(slot.instant, tz), ...metrics.map((m) => slot.values[m.key] ?? '')].join(',');
  if (parsed.version < target) {
    // Schema bump: new header once, untouched rows get empty trailing cells (only written if a value changes below).
    lines[0]!.raw = `${lines[0]!.raw.startsWith(BOM) ? BOM : ''}${ringSlotHeader(target)}`;
    for (const row of rows) row.raw += ','.repeat(metrics.length - metricsOf(parsed.version).length);
  }
  let changed = existing === null;
  for (const sent of [...slots].sort((a, b) => a.instant - b.instant)) {
    const row = rows.find((r) => r.slot.instant === sent.instant);
    if (row) {
      if (applySent(row.slot, sent, sentMetrics)) { row.raw = format(row.slot); changed = true; }
      continue;
    }
    const slot = { instant: sent.instant, values: emptyValues() }, at = rows.findIndex((r) => r.slot.instant > sent.instant);
    applySent(slot, sent, sentMetrics);
    rows.splice(at < 0 ? rows.length : at, 0, { slot, raw: format(slot), end: eol });
    changed = true;
  }
  if (!changed) return { ok: true, text: existing!, changed: false };
  const text = joinRingLines([lines[0]!, ...rows], eol, final);
  // The merged file must parse like any stored file (e.g. a partial sleep merge may exceed 15 min).
  const validated = parseSlotFile(text);
  return validated.ok ? { ok: true, text, changed: text !== existing } : validated;
}
