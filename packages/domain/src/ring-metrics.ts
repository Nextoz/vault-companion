export type RingKey = 'steps' | 'hr' | 'hrMin' | 'hrMax' | 'spo2' | 'bpSys' | 'bpDia' | 'fatigue' | 'stress' | 'hrvMs' | 'tempC' | 'sleepLightMin' | 'sleepDeepMin' | 'sleepAwakeMin';
export type RingValueRule = { kind: 'int'; min: 0; max?: number } | { kind: 'decimal'; decimals: 2; min: 0 };
export interface RingDailyAgg {
  column: string; scope: 'day' | 'night'; fn: 'mean' | 'min' | 'median' | 'sum' | 'count'; decimals: 0 | 1; minCount?: number;
}
export interface RingMetric {
  key: RingKey; column: string; unit: 'count' | 'bpm' | '%' | 'mmHg' | 'ms' | 'degC' | 'min' | 'score';
  value: RingValueRule; since: number; sumGroup?: { id: 'sleep'; max: 15 }; daily: readonly RingDailyAgg[];
  strip: string; chart: 'line' | 'band-low' | 'band-high' | 'bars' | 'stage' | 'dots'; colour: `ring-${string}`; labelUnverified: boolean;
}
const agg = (column: string, fn: RingDailyAgg['fn'], decimals: 0 | 1 = 0, scope: 'day' | 'night' = 'day', minCount?: number): RingDailyAgg =>
  ({ column, fn, decimals, scope, ...(minCount === undefined ? {} : { minCount }) });
const metric = (key: RingKey, column: string, unit: RingMetric['unit'], chart: RingMetric['chart'], daily: readonly RingDailyAgg[] = [], strip = column): RingMetric => ({
  key, column, unit, chart, daily, since: 1, value: { kind: 'int', min: 0 }, strip, colour: `ring-${column}`,
  labelUnverified: key === 'fatigue' || key === 'stress' || key === 'hrvMs',
});
const sleep = (key: RingKey, column: string, dailyColumn: string): RingMetric => ({
  ...metric(key, column, 'min', 'stage', [agg(dailyColumn, 'sum', 0, 'night')]),
  value: { kind: 'int', min: 0, max: 15 }, sumGroup: { id: 'sleep', max: 15 }, strip: 'sleep',
});
export const RING_METRICS: readonly RingMetric[] = [
  metric('steps', 'steps', 'count', 'bars'),
  metric('hr', 'hr', 'bpm', 'line', [agg('avg_hr', 'mean'), agg('hr_n', 'count'), agg('resting_hr', 'median', 0, 'night', 3)]),
  metric('hrMin', 'hr_min', 'bpm', 'band-low', [], 'hr'),
  metric('hrMax', 'hr_max', 'bpm', 'band-high', [], 'hr'),
  metric('spo2', 'spo2', '%', 'line', [agg('min_spo2', 'min', 1), agg('avg_spo2', 'mean', 1), agg('spo2_n', 'count')]),
  metric('bpSys', 'bp_sys', 'mmHg', 'dots', [], 'bp'), metric('bpDia', 'bp_dia', 'mmHg', 'dots', [], 'bp'),
  metric('fatigue', 'fatigue', 'score', 'line'), metric('stress', 'stress', 'score', 'line'),
  metric('hrvMs', 'hrv_ms', 'ms', 'line', [agg('hrv_sdnn_ms', 'mean'), agg('hrv_n', 'count')]),
  { ...metric('tempC', 'temp_c', 'degC', 'line', [agg('body_temp_c', 'mean', 1), agg('temp_n', 'count')]), value: { kind: 'decimal', decimals: 2, min: 0 } },
  sleep('sleepLightMin', 'sleep_light_min', 'light_min'), sleep('sleepDeepMin', 'sleep_deep_min', 'deep_min'), sleep('sleepAwakeMin', 'sleep_awake_min', 'awake_min'),
];
export const RING_SCHEMAS: Readonly<Record<string, number>> = { 'ring-slots/1': 1 };
export function ringSlotHeader(version: number): string {
  return ['slot_start', ...RING_METRICS.filter((m) => m.since <= version).map((m) => m.column)].join(',');
}
export const RING_DAILY_HEADER = 'date,weekday,sleep_start,sleep_end,light_min,deep_min,awake_min,resting_hr,avg_hr,min_spo2,avg_spo2,hrv_sdnn_ms,body_temp_c,hr_n,spo2_n,hrv_n,temp_n,sleep_n';
