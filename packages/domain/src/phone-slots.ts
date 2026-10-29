import { PHONE_METRICS, type PhoneMetric } from './phone-metrics.ts';
import type { PhoneSample } from './phone-samples.ts';
import { splitByMonth } from './ring-slots.ts';
import { DEFAULT_USER_TIME_ZONE } from './time.ts';

export type PhoneSlot = { instant: number; values: Record<string, number | null> };
const SLOT = 900_000;
export const splitPhoneSlotsByMonth = (slots: readonly PhoneSlot[], tz = DEFAULT_USER_TIME_ZONE): Map<string, PhoneSlot[]> => splitByMonth(slots, tz);
const round = (value: number, decimals: number) => Number(value.toFixed(decimals));
function unionMinutes(ranges: [number, number][]): number {
  let end = -Infinity, total = 0;
  for (const [a, b] of ranges.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b);
  }
  return round(total / 60_000, 1);
}

/** Allocate before applying the send window, so dropping incomplete history cannot redistribute totals. */
export function aggregatePhoneSlots(samples: readonly PhoneSample[], from: Date, sentAt: Date, tz = DEFAULT_USER_TIME_ZONE): PhoneSlot[] {
  // Validate the same zone used to name the resulting monthly files. Boundaries are UTC multiples in Copenhagen.
  new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  const rows = new Map<number, PhoneSlot>();
  const put = (instant: number, column: string, value: number) => {
    if (instant < from.getTime() + 3_600_000 || instant > sentAt.getTime()) return;
    let row = rows.get(instant);
    if (!row) {
      row = { instant, values: Object.fromEntries(PHONE_METRICS.flatMap((m) => m.columns.map((c) => [c, null]))) };
      rows.set(instant, row);
    }
    row.values[column] = value;
  };
  for (const metric of PHONE_METRICS as readonly PhoneMetric[]) {
    const selected = samples.filter((s) => s.key === metric.key && (metric.slot !== 'union-min' || s.inBed === true));
    const groups = new Map<number, { sample: PhoneSample; a: number; b: number; value: number }[]>();
    for (const sample of selected) {
      const pieces: { instant: number; a: number; b: number; value: number }[] = [];
      const start = Math.floor(sample.start / SLOT) * SLOT;
      const point = sample.start === sample.end;
      const byStart = metric.slot === 'mean' || metric.slot === 'last';
      for (let instant = start; instant < sample.end || instant === start; instant += SLOT) {
        const a = Math.max(instant, sample.start), b = Math.min(instant + SLOT, sample.end);
        pieces.push({ instant, a, b, value: metric.slot === 'sum-prorata' && !point ? sample.value * (b - a) / (sample.end - sample.start) : sample.value });
        if (point || byStart) break;
      }
      if (metric.slot === 'sum-prorata' && metric.value.kind === 'int' && !point) {
        const duration = BigInt(sample.end - sample.start), total = BigInt(sample.value);
        const ranked = pieces.map((p) => {
          const numerator = total * BigInt(p.b - p.a);
          p.value = Number(numerator / duration);
          return { p, remainder: numerator % duration };
        }).sort((a, b) => a.remainder === b.remainder ? a.p.instant - b.p.instant : a.remainder > b.remainder ? -1 : 1);
        const left = sample.value - pieces.reduce((sum, p) => sum + p.value, 0);
        for (let i = 0; i < left; i++) ranked[i]!.p.value++;
      }
      for (const { instant, ...piece } of pieces) {
        if (!groups.has(instant)) groups.set(instant, []);
        groups.get(instant)!.push({ ...piece, sample });
      }
    }
    for (const [instant, pieces] of groups) {
      const column = metric.columns[0]!;
      if (metric.slot === 'sum-prorata' || metric.slot === 'mean') {
        const sum = pieces.reduce((n, p) => n + p.value, 0);
        put(instant, column, round(metric.slot === 'mean' ? sum / pieces.length : sum, metric.value.decimals));
      } else if (metric.slot === 'last') {
        // Equal starts use the larger value, making the result independent of input order.
        pieces.sort((a, b) => b.sample.start - a.sample.start || b.value - a.value);
        put(instant, column, pieces[0]!.value);
      } else {
        const duration = pieces.reduce((n, p) => n + p.b - p.a, 0);
        if (!duration) continue;
        const minutes = unionMinutes(pieces.map((p) => [p.a, p.b]));
        if (metric.slot === 'union-min') put(instant, column, minutes);
        else {
          const peak = Math.max(...pieces.map((p) => p.value));
          const energy = pieces.reduce((n, p) => n + (p.b - p.a) * 10 ** ((p.value - peak) / 10), 0);
          put(instant, column, round(peak + 10 * Math.log10(energy / duration), metric.value.decimals));
          put(instant, metric.columns[1]!, minutes);
        }
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.instant - b.instant);
}
