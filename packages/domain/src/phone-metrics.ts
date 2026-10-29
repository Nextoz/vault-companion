export type PhoneValueRule = { kind: 'int' | 'decimal'; decimals: number; min: 0; max?: number };
export type PhoneAggregation = 'sum-prorata' | 'mean' | 'last' | 'energy-mean' | 'union-min';
export interface PhoneMetric {
  key: string; typeName: string; hkIdentifier: string; columns: readonly string[]; unit: string;
  units: Readonly<Record<string, readonly [number, number]>>; value: PhoneValueRule;
  slot: PhoneAggregation; daily: readonly { column: string; fn: PhoneAggregation | 'sum'; decimals: number }[];
  since: number; required?: boolean; category?: string;
}
const metric = <K extends string>(key: K, typeName: string, hkIdentifier: string, column: string, unit: string,
  units: PhoneMetric['units'], decimals: number, slot: PhoneAggregation, max?: number): PhoneMetric & { key: K } => ({
  key, typeName, hkIdentifier, columns: [column], unit, units, since: 1, slot,
  value: { kind: decimals === 0 ? 'int' : 'decimal', decimals, min: 0, ...(max === undefined ? {} : { max }) },
  daily: [{ column, fn: slot === 'sum-prorata' ? 'sum' : slot, decimals }],
});
export const PHONE_METRICS = [
  { ...metric('steps', 'Steps', 'StepCount', 'steps', 'count', { count: [1, 1] }, 0, 'sum-prorata'), required: true },
  metric('distance', 'Walking + Running Distance', 'DistanceWalkingRunning', 'distance_km', 'km', { km: [1, 1], m: [1, 1000], mi: [1609344, 1000000] }, 3, 'sum-prorata'),
  metric('flights', 'Flights Climbed', 'FlightsClimbed', 'flights', 'count', { count: [1, 1] }, 0, 'sum-prorata'),
  metric('activeEnergy', 'Active Energy', 'ActiveEnergyBurned', 'active_kcal', 'kcal', { kcal: [1, 1] }, 1, 'sum-prorata'),
  metric('walkingSpeed', 'Walking Speed', 'WalkingSpeed', 'walking_speed_kmh', 'km/h', { 'km/hr': [1, 1], 'm/s': [36, 10] }, 2, 'mean'),
  metric('stepLength', 'Walking Step Length', 'WalkingStepLength', 'step_length_cm', 'cm', { cm: [1, 1], m: [100, 1] }, 2, 'mean'),
  metric('asymmetry', 'Walking Asymmetry', 'WalkingAsymmetryPercentage', 'asymmetry_pct', '%', { '%': [1, 1] }, 1, 'mean', 100),
  metric('doubleSupport', 'Double Support Time', 'WalkingDoubleSupportPercentage', 'double_support_pct', '%', { '%': [1, 1] }, 1, 'mean', 100),
  metric('steadiness', 'Walking Steadiness', 'AppleWalkingSteadiness', 'steadiness_pct', '%', { '%': [1, 1] }, 1, 'last', 100),
  metric('sixMinWalk', 'Six-Minute Walk', 'SixMinuteWalkTestDistance', 'six_min_walk_m', 'm', { m: [1, 1] }, 2, 'last'),
  metric('stairUp', 'Stair Speed: Up', 'StairAscentSpeed', 'stair_up_mps', 'm/s', { 'm/s': [1, 1] }, 2, 'mean'),
  metric('stairDown', 'Stair Speed: Down', 'StairDescentSpeed', 'stair_down_mps', 'm/s', { 'm/s': [1, 1] }, 2, 'mean'),
  { ...metric('headphone', 'Headphone Audio Levels', 'HeadphoneAudioExposure', 'headphone_db', 'dBASPL', { dBASPL: [1, 1] }, 2, 'energy-mean'),
    columns: ['headphone_db', 'headphone_min'], daily: [{ column: 'headphone_min', fn: 'sum', decimals: 1 }, { column: 'headphone_db', fn: 'energy-mean', decimals: 2 }] },
  { ...metric('inBed', 'Sleep', 'SleepAnalysis', 'in_bed_min', 'min', { '': [1, 1] }, 1, 'union-min'),
    category: 'In Bed', daily: [{ column: 'in_bed_min', fn: 'sum', decimals: 1 }] },
] as const satisfies readonly PhoneMetric[];
export type PhoneKey = typeof PHONE_METRICS[number]['key'];
export const PHONE_SCHEMAS: Readonly<Record<string, number>> = { 'phone-slots/1': 1 };
export function phoneSlotHeader(version: number, metrics: readonly PhoneMetric[] = PHONE_METRICS): string {
  return ['slot_start', ...metrics.filter((m) => m.since <= version).flatMap((m) => m.columns)].join(',');
}
export const PHONE_SLOT_HEADER = phoneSlotHeader(1);
export function activityDailyHeader(version: number, metrics: readonly PhoneMetric[] = PHONE_METRICS): string {
  return ['date', 'weekday', 'steps_phone', 'steps_ring', 'steps_combined', 'steps_phone_slots', 'steps_ring_slots', 'steps_both_slots',
    ...metrics.filter((m) => m.since <= version && !m.required).flatMap((m) => m.daily.map((a) => a.column))].join(',');
}
export const ACTIVITY_DAILY_HEADER = activityDailyHeader(1);

/** Exact rational conversion, rounded half up once at the stored precision. */
export function convertPhoneValue(text: string, ratio: readonly [number, number], rule: PhoneValueRule): number | null {
  if (text.length > 100 || !(rule.kind === 'int' ? /^\d+$/ : /^\d+(?:\.\d+)?$/).test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(ratio[0]);
  const denominator = 10n ** BigInt(fraction.length) * BigInt(ratio[1]);
  if (rule.max !== undefined && numerator > BigInt(rule.max) * denominator) return Infinity;
  const scale = 10n ** BigInt(rule.decimals);
  const scaled = (numerator * scale * 2n + denominator) / (denominator * 2n);
  return scaled > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(scaled) / Number(scale);
}
