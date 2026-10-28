import { describe, expect, it } from 'vitest';
import { RING_DAILY_HEADER, RING_METRICS, ringSlotHeader } from './ring-metrics.ts';
describe('ring registry', () => {
  it('matches the ADR headers and daily column set', () => {
    expect(ringSlotHeader(1)).toBe('slot_start,steps,hr,hr_min,hr_max,spo2,bp_sys,bp_dia,fatigue,stress,hrv_ms,temp_c,sleep_light_min,sleep_deep_min,sleep_awake_min');
    expect(RING_DAILY_HEADER).toBe('date,weekday,sleep_start,sleep_end,light_min,deep_min,awake_min,resting_hr,avg_hr,min_spo2,avg_spo2,hrv_sdnn_ms,body_temp_c,hr_n,spo2_n,hrv_n,temp_n,sleep_n');
    expect(new Set(['date', 'weekday', 'sleep_start', 'sleep_end', 'sleep_n', ...RING_METRICS.flatMap((m) => m.daily.map((d) => d.column))])).toEqual(new Set(RING_DAILY_HEADER.split(',')));
    expect(new Set(RING_METRICS.map((m) => m.key)).size).toBe(14);
    expect(RING_METRICS.filter((m) => m.labelUnverified).map((m) => m.key)).toEqual(['fatigue', 'stress', 'hrvMs']);
  });
  it('groups strips like design A', () => {
    expect([...new Set(RING_METRICS.map((m) => m.strip))]).toEqual(['steps', 'hr', 'spo2', 'bp', 'fatigue', 'stress', 'hrv_ms', 'temp_c', 'sleep']);
  });
});
