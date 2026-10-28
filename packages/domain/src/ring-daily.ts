import { formatNumber, wallClockDate, weekday } from './health-format.ts';
import { RING_DAILY_HEADER, RING_METRICS } from './ring-metrics.ts';
import { canonicalSlotStart, type RingSlot } from './ring-slots.ts';
import { ringFileLines, ringStructureRefusal, type RingFileMerge } from './ring-slot-file.ts';

const sleep = (s: RingSlot) => RING_METRICS.reduce((sum, m) => sum + (m.sumGroup?.id === 'sleep' ? s.values[m.key] ?? 0 : 0), 0) > 0;
export function ringNightSessions(slots: readonly RingSlot[], tz: string) {
  const sessions: { start: number; end: number; date: string; slots: RingSlot[] }[] = [];
  for (const slot of [...slots].filter(sleep).sort((a, b) => a.instant - b.instant)) {
    let session = sessions.at(-1);
    if (!session || slot.instant - (session.end - 900000) > 75 * 60000) {
      session = { start: slot.instant, end: slot.instant + 900000, date: '', slots: [] }; sessions.push(session);
    }
    session.slots.push(slot); session.end = slot.instant + 900000;
    session.date = wallClockDate(session.end, tz, -3);
  }
  return sessions;
}
export function affectedDates(sent: readonly RingSlot[], merged: readonly RingSlot[], tz: string): string[] {
  const dates = new Set(sent.map((s) => wallClockDate(s.instant, tz, 0))), sessions = ringNightSessions(merged, tz);
  for (const s of sent.filter(sleep)) {
    const session = sessions.find((n) => n.slots.some((v) => v.instant === s.instant));
    if (session) dates.add(session.date);
  }
  return [...dates].sort();
}
export function deriveRingDaily(slots: readonly RingSlot[], dates: readonly string[], tz: string): Map<string, string> {
  const rows = new Map<string, string>(), sessions = ringNightSessions(slots, tz);
  for (const date of dates) {
    const day = slots.filter((s) => wallClockDate(s.instant, tz, 0) === date);
    if (!day.length) continue;
    const night = sessions.filter((s) => s.date === date).sort((a, b) => (b.end - b.start) - (a.end - a.start) || b.start - a.start)[0];
    const cells: Record<string, string> = { date, weekday: weekday(date), sleep_start: night ? canonicalSlotStart(night.start, tz) : '', sleep_end: night ? canonicalSlotStart(night.end, tz) : '', sleep_n: String(night?.slots.length ?? 0) };
    for (const m of RING_METRICS) for (const agg of m.daily) {
      const scope = agg.scope === 'day' ? day : !night ? [] : m.sumGroup?.id === 'sleep' ? night.slots : slots.filter((s) => s.instant >= night.start && s.instant < night.end);
      const values = scope.map((s) => s.values[m.key]).filter((v): v is number => v != null).sort((a, b) => a - b), n = values.length;
      let value: number | null = null;
      if (agg.fn === 'count') value = n;
      else if (n >= (agg.minCount ?? 1)) {
        const sum = values.reduce((a, b) => a + b, 0);
        value = agg.fn === 'sum' ? sum : agg.fn === 'mean' ? sum / n : agg.fn === 'min' ? values[0]! : (values[Math.floor((n - 1) / 2)]! + values[Math.floor(n / 2)]!) / 2;
      } else if (agg.fn === 'sum' && night) value = 0;
      cells[agg.column] = value === null ? '' : formatNumber(value, agg.decimals);
    }
    rows.set(date, RING_DAILY_HEADER.split(',').map((c) => cells[c] ?? '').join(','));
  }
  return rows;
}
export function mergeDailyFile(existing: string | null, rows: ReadonlyMap<string, string>): RingFileMerge {
  const lines = ringFileLines(existing ?? `${RING_DAILY_HEADER}\n`), eol = lines.find((l) => l.end)?.end ?? '\n';
  if (lines[0]?.raw.replace(/^\uFEFF/, '') !== RING_DAILY_HEADER) return ringStructureRefusal;
  const final = lines.at(-1)!.end;
  for (const [date, raw] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    const at = lines.findIndex((l, i) => i > 0 && l.raw.split(',')[0] === date);
    if (at >= 0) lines[at]!.raw = raw;
    else {
      const next = lines.findIndex((l, i) => i > 0 && /^\d{4}-\d{2}-\d{2},/.test(l.raw) && l.raw.slice(0, 10) > date);
      lines.splice(next < 0 ? lines.length : next, 0, { raw, end: eol });
    }
  }
  lines.forEach((l, i) => { if (i === lines.length - 1) l.end = final; else if (!l.end) l.end = eol; });
  const text = lines.map((l) => l.raw + l.end).join('');
  return { ok: true, text, changed: text !== existing };
}
