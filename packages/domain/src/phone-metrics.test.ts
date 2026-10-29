import { describe, expect, it } from 'vitest';
import { ACTIVITY_DAILY_HEADER, PHONE_METRICS, PHONE_SLOT_HEADER, activityDailyHeader, phoneSlotHeader, type PhoneMetric } from './phone-metrics.ts';

describe('phone registry', () => {
  it('matches both ADR-0070 headers byte for byte', () => {
    expect(PHONE_SLOT_HEADER).toBe('slot_start,steps,distance_km,flights,active_kcal,walking_speed_kmh,step_length_cm,asymmetry_pct,double_support_pct,steadiness_pct,six_min_walk_m,stair_up_mps,stair_down_mps,headphone_db,headphone_min,in_bed_min');
    expect(ACTIVITY_DAILY_HEADER).toBe('date,weekday,steps_phone,steps_ring,steps_combined,steps_phone_slots,steps_ring_slots,steps_both_slots,distance_km,flights,active_kcal,walking_speed_kmh,step_length_cm,asymmetry_pct,double_support_pct,steadiness_pct,six_min_walk_m,stair_up_mps,stair_down_mps,headphone_min,headphone_db,in_bed_min');
  });
  it('has unique keys, columns, type names and HealthKit identifiers', () => {
    for (const values of [PHONE_METRICS.map((m) => m.key), PHONE_METRICS.flatMap((m) => m.columns),
      PHONE_METRICS.map((m) => m.typeName), PHONE_METRICS.map((m) => m.hkIdentifier)]) {
      expect(new Set(values).size).toBe(values.length);
    }
    expect(PHONE_METRICS).toHaveLength(14);
    expect(PHONE_METRICS.every((m) => m.since === 1)).toBe(true);
  });
  it('appends a future metric without changing either v1 header', () => {
    const future: PhoneMetric = { ...PHONE_METRICS[1], key: 'synthetic', typeName: 'Synthetic', hkIdentifier: 'Synthetic',
      since: 2, columns: ['synthetic'], daily: [{ column: 'synthetic', fn: 'sum', decimals: 1 }] };
    const metrics = [...PHONE_METRICS, future];
    expect(phoneSlotHeader(1, metrics)).toBe(PHONE_SLOT_HEADER);
    expect(phoneSlotHeader(2, metrics)).toBe(`${PHONE_SLOT_HEADER},synthetic`);
    expect(activityDailyHeader(1, metrics)).toBe(ACTIVITY_DAILY_HEADER);
    expect(activityDailyHeader(2, metrics)).toBe(`${ACTIVITY_DAILY_HEADER},synthetic`);
  });
});
