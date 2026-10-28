import { RING_METRICS, RING_SCHEMAS, ringSlotHeader } from './ring-metrics.ts';
import { canonicalSlotStart, type RingSlot } from './ring-slots.ts';

export const ringStructureRefusal = { ok: false, code: 'refused:structure', message: 'ring file has an unexpected structure' } as const;
export type RingFileMerge = { ok: true; text: string; changed: boolean } | typeof ringStructureRefusal;
// Retain each line's terminator, including mixed EOLs and an absent final newline.
export function ringFileLines(text: string): { raw: string; end: string }[] {
  return [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter((m) => m[0] !== '').map((m) => ({ raw: m[1]!, end: m[2]! }));
}
export function parseSlotFile(text: string): { ok: true; version: number; slots: RingSlot[] } | typeof ringStructureRefusal {
  const lines = ringFileLines(text), header = lines[0]?.raw.replace(/^\uFEFF/, '');
  const version = Object.values(RING_SCHEMAS).find((v) => ringSlotHeader(v) === header);
  if (version === undefined) return ringStructureRefusal;
  const metrics = RING_METRICS.filter((m) => m.since <= version), slots: RingSlot[] = [], seen = new Set<number>();
  for (const { raw } of lines.slice(1)) {
    const [start = '', ...cells] = raw.split(','), instant = Date.parse(start);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:(00|15|30|45):00(?:Z|[+-]\d{2}:\d{2})$/.test(start) || !Number.isFinite(instant) || seen.has(instant) || cells.length !== metrics.length) return ringStructureRefusal;
    // Date.parse normalizes invalid calendar dates; reject those rather than repair them.
    if (new Date(`${start.slice(0, 19)}Z`).toISOString().slice(0, 19) !== start.slice(0, 19)) return ringStructureRefusal;
    const values = Object.fromEntries(RING_METRICS.map((m) => [m.key, null])) as RingSlot['values'], sums = new Map<string, number>();
    for (const [i, m] of metrics.entries()) {
      const cell = cells[i]!, v = cell === '' ? null : Number(cell), rule = m.value;
      if (v !== null && (!/^\d+(?:\.\d+)?$/.test(cell) || !Number.isFinite(v) || v < rule.min || (rule.kind === 'int' ? !Number.isInteger(v) || cell.includes('.') || (rule.max !== undefined && v > rule.max) : Number(v.toFixed(rule.decimals)) !== v))) return ringStructureRefusal;
      values[m.key] = v;
      if (m.sumGroup) {
        const sum = (sums.get(m.sumGroup.id) ?? 0) + (v ?? 0);
        if (sum > m.sumGroup.max) return ringStructureRefusal;
        sums.set(m.sumGroup.id, sum);
      }
    }
    seen.add(instant); slots.push({ instant, values });
  }
  return { ok: true, version, slots };
}
export function mergeSlotFile(existing: string | null, slots: readonly RingSlot[], version: number, tz: string): RingFileMerge {
  if (!Object.values(RING_SCHEMAS).includes(version)) return ringStructureRefusal;
  const parsed = existing === null ? { ok: true as const, version, slots: [] as RingSlot[] } : parseSlotFile(existing);
  if (!parsed.ok) return parsed;
  const target = Math.max(...Object.values(RING_SCHEMAS)), metrics = RING_METRICS.filter((m) => m.since <= target);
  const lines = ringFileLines(existing ?? `${ringSlotHeader(target)}\n`), eol = lines.find((l) => l.end)?.end ?? '\n';
  const final = lines.at(-1)!.end, rows = parsed.slots.map((slot, i) => ({ slot, ...lines[i + 1]! }));
  const format = (slot: RingSlot) => [canonicalSlotStart(slot.instant, tz), ...metrics.map((m) => slot.values[m.key] ?? '')].join(',');
  if (parsed.version < target) {
    lines[0]!.raw = `${existing?.startsWith('\uFEFF') ? '\uFEFF' : ''}${ringSlotHeader(target)}`;
    for (const row of rows) row.raw += ','.repeat(metrics.length - RING_METRICS.filter((m) => m.since <= parsed.version).length);
  }
  for (const sent of [...slots].sort((a, b) => a.instant - b.instant)) {
    const row = rows.find((r) => r.slot.instant === sent.instant);
    if (row) {
      let changed = false;
      for (const m of metrics) if (m.since <= version && sent.values[m.key] != null && sent.values[m.key] !== row.slot.values[m.key]) {
        row.slot.values[m.key] = sent.values[m.key]; changed = true;
      }
      if (changed) row.raw = format(row.slot);
    } else {
      const slot = { instant: sent.instant, values: Object.fromEntries(metrics.map((m) => [m.key, m.since <= version ? sent.values[m.key] ?? null : null])) as RingSlot['values'] };
      const at = rows.findIndex((r) => r.slot.instant > slot.instant);
      rows.splice(at < 0 ? rows.length : at, 0, { slot, raw: format(slot), end: eol });
    }
  }
  const output = [lines[0]!, ...rows];
  output.forEach((line, i) => { if (i === output.length - 1) line.end = final; else if (!line.end) line.end = eol; });
  const text = output.map((l) => l.raw + l.end).join('');
  return { ok: true, text, changed: text !== existing };
}
