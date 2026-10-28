import type { RingSlot } from '@vault-companion/contracts';
// ADR-0068: registry metadata drives the deferred ring view without a second metric list.
// eslint-disable-next-line no-restricted-imports
import { RING_METRICS, type RingMetric } from '@vault-companion/domain';

export const STRIP_ORDER = ['sleep', 'hr', 'spo2', 'steps', 'bp', 'stress', 'fatigue', 'hrv_ms', 'temp_c'] as const;
export const SLOT_MS = 15 * 60_000;
export const slotX = (start: string, dayStart: string, dayEnd: string) =>
  (Date.parse(start) - Date.parse(dayStart)) / (Date.parse(dayEnd) - Date.parse(dayStart));

/** Elapsed hours, formatted in the vault's local zone, including repeated/skipped hours. End is 24. */
export function hourTicks(dayStart: string, dayEnd: string, timeZone = 'Europe/Copenhagen') {
  const start = Date.parse(dayStart), end = Date.parse(dayEnd);
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  return Array.from({ length: (end - start) / 3_600_000 + 1 }, (_, i) => ({
    x: i * 3_600_000 / (end - start), label: start + i * 3_600_000 === end ? '24' : hour.format(start + i * 3_600_000),
  }));
}

export function groupStrips(metrics: readonly RingMetric[] = RING_METRICS) {
  const groups = new Map<string, RingMetric[]>();
  for (const metric of metrics) groups.set(metric.strip, [...(groups.get(metric.strip) ?? []), metric]);
  return [...new Set<string>([...STRIP_ORDER, ...groups.keys()])]
    .filter(name => groups.has(name)).map(name => ({ name, metrics: groups.get(name)! }));
}

export function lineSegments(slots: readonly RingSlot[], metric: RingMetric) {
  const adjacent = metric.strip === 'hr' || metric.chart === 'bars';
  const segments: { start: string; value: number }[][] = [];
  let previous = -Infinity;
  for (const slot of slots) {
    const value = slot.values[metric.key];
    if (value == null) continue;
    const instant = Date.parse(slot.start);
    if (instant - previous > SLOT_MS * (adjacent ? 1 : 2)) segments.push([]);
    segments[segments.length - 1]!.push({ start: slot.start, value });
    previous = instant;
  }
  return segments;
}

export const metricLabel = (metric: RingMetric) => ({
  hr: 'Heart rate', hr_min: 'HR min', hr_max: 'HR max', spo2: 'SpO₂', bp_sys: 'Systolic', bp_dia: 'Diastolic',
  hrv_ms: 'HRV', temp_c: 'Temperature', sleep_light_min: 'Light sleep', sleep_deep_min: 'Deep sleep', sleep_awake_min: 'Awake',
}[metric.column] ?? metric.column.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase()));
export const metricValue = (value: number | null | undefined, metric: RingMetric) => value == null ? '—'
  : `${value}${({ count: '', score: '', degC: ' °C' } as Record<string, string>)[metric.unit] ?? ` ${metric.unit}`}`;
