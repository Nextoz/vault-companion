// MB1b gatherer tests. All fixtures are synthetic: no private vault text, no real check-ins. Every mapper is tested
// directly; the gatherer is tested for partial failure, no-throw, and empty-in/empty-out.
import { describe, expect, it } from 'vitest';
import type {
  HealthHistoryDay,
  HealthHistoryResponse,
  MoodCheckinPayload,
  TaskView,
  TasksResponse,
  TrainingResponse,
  TrainingRow,
  WeatherModelSeries,
  WeatherPoint,
  WeatherResponse,
} from '@vault-companion/contracts';
import {
  gatherCandidates,
  latestMood,
  recentTraining,
  toBriefTodos,
  toHealthMetrics,
  toWeatherWindows,
  type MorningBriefGatherDeps,
} from './morning-brief-gather.ts';

const DAY = '2026-06-15';
const TZ = 'Europe/Copenhagen';
const SHA = 'a'.repeat(40);
const FUTURE = '2026-06-16';
const BEFORE_WINDOW = '2026-06-08';

const task = (status: TaskView['status'], description: string, due: string | null = null): TaskView => ({
  locator: { path: 'Tasks/To-Do List.md', blobSha: SHA, lineIndex: 0, lineText: description, occurrencesAtRead: 1 },
  description,
  status,
  section: status === 'done' ? 'done' : 'open',
  priority: null,
  due,
  scheduled: null,
  start: null,
  created: null,
  done: null,
  recurring: false,
  readOnlyReason: null,
  links: [],
});

const tasksResponse = (allOpen: readonly TaskView[]): TasksResponse => ({
  vault: null,
  revision: SHA,
  blobSha: SHA,
  today: DAY,
  timeZone: TZ,
  writeBlock: null,
  known: {},
  todayTasks: [],
  overdue: [],
  allOpen: [...allOpen],
  doneToday: [],
});

const hday = (date: string, over: Partial<HealthHistoryDay> = {}): HealthHistoryDay => ({
  date,
  steps: null,
  headphone_min: null,
  first_move: null,
  last_move: null,
  ...over,
});

const healthResponse = (days: readonly HealthHistoryDay[]): HealthHistoryResponse => ({ revision: SHA, now: '2026-06-15T05:00:00Z', status: 'ok', days: [...days] });

const mood = (date: string, checkinAt: string, values: [number, number, number]): MoodCheckinPayload => ({
  date,
  mood: values[0],
  energy: values[1],
  sleep: values[2],
  checkinAt,
});

const trow = (date: string, note: string): TrainingRow => ({ date, time: '07:00', type: 'Run', distance: '5 km', duration: '30 min', weight: '', split: '', note });

const trainingResponse = (rows: readonly TrainingRow[]): TrainingResponse => ({ status: 'ok', revision: SHA, blobSha: SHA, rows: [...rows], unknownLines: [] });

const wp = (time: string, over: Partial<WeatherPoint> = {}): WeatherPoint => ({ time, temperatureC: 15, rainMm: 0, windMs: 3, ...over });

const model = (points: readonly WeatherPoint[]): WeatherModelSeries => ({
  model: 'dmi_harmonie_arome_europe',
  label: 'DMI HARMONIE AROME Europe',
  resolutionKm: 2,
  sourceUrl: 'https://open-meteo.com/en/docs/dmi-api',
  retrievedAt: '2026-06-15T05:00:00Z',
  expectedPoints: 48,
  points: [...points],
  missingIntervals: 0,
});

const weatherResponse = (models: readonly WeatherModelSeries[]): WeatherResponse => ({
  status: 'ok',
  projection: {
    location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' },
    now: '2026-06-15T05:00:00Z',
    models: [...models],
    agreement: models.length >= 2 ? 'two-models' : 'single-model',
    coverage: { expectedPoints: 48, primaryReturned: models[0]?.points.length ?? 0, comparisonReturned: models[1]?.points.length ?? 0, primaryMissingIntervals: 0, comparisonMissingIntervals: 0 },
    runWindow: null,
    partialError: 'none',
    attribution: 'Forecast data by DMI and ECMWF via Open-Meteo, CC-BY 4.0.',
    termsUrl: 'https://open-meteo.com/en/terms',
  },
});

/** Hourly points 08:00-19:59 local on DAY (CEST = UTC+2), so chooseRunWindow has windows to pick from. */
const briefDayPoints = (over: (localHour: number) => Partial<WeatherPoint> = () => ({})): WeatherPoint[] =>
  Array.from({ length: 12 }, (_, i) => wp(new Date(Date.UTC(2026, 5, 15, 6 + i)).toISOString(), over(8 + i)));

describe('toBriefTodos', () => {
  it('keeps open tasks in read order and drops closed ones', () => {
    const tasks = [task('open', 'Alpha', '2026-06-15'), task('done', 'Beta', '2026-06-14'), task('open', 'Gamma')];
    expect(toBriefTodos(tasks)).toEqual([
      { text: 'Alpha', due: '2026-06-15', bill: false },
      { text: 'Gamma', due: null, bill: false },
    ]);
  });

  it('never marks a bill: the contract carries no bill/payment marker', () => {
    expect(toBriefTodos([task('open', 'Pay rent', '2026-06-16')])).toEqual([{ text: 'Pay rent', due: '2026-06-16', bill: false }]);
  });

  it('empty input is empty output', () => {
    expect(toBriefTodos([])).toEqual([]);
  });
});

describe('toHealthMetrics', () => {
  const baseline = Array.from({ length: 20 }, (_, i) =>
    hday(`2026-05-${String(i + 1).padStart(2, '0')}`, { steps: 1000, headphone_min: 60, first_move: 600, last_move: 600 }));

  it('derives value, baseline, compare and a 30-day series for the newest day at/before the brief day', () => {
    const days = [...baseline, hday(FUTURE, { steps: 99999 }), hday(DAY, { steps: 5000, headphone_min: 60, first_move: 620, last_move: 640 })];
    const metrics = toHealthMetrics(days, DAY);
    expect(metrics.map((m) => m.key)).toEqual(['steps', 'headphone_min', 'first_move', 'last_move']);
    expect(metrics[0]).toMatchObject({ key: 'steps', value: 5000, baseline: 1000, compare: 'above' });
    expect(metrics[0]!.series).toHaveLength(30);
    expect(metrics[0]!.series.at(-1)).toBe(5000);
    expect(metrics[0]!.series[0]).toBe(1000); // 2026-05-17, inside the baseline
    expect(metrics[0]!.series[4]).toBeNull(); // 2026-05-21, before the baseline
    expect(metrics[1]).toMatchObject({ key: 'headphone_min', compare: 'usual' });
    // Time keys use a +/-30 minute tolerance: +20 min is usual, +40 min is above.
    expect(metrics[2]).toMatchObject({ key: 'first_move', value: 620, compare: 'usual' });
    expect(metrics[3]).toMatchObject({ key: 'last_move', value: 640, compare: 'above' });
  });

  it('is empty when there is no history', () => {
    expect(toHealthMetrics([], DAY)).toEqual([]);
  });

  it('is empty when every row is after the brief day', () => {
    expect(toHealthMetrics([hday(FUTURE, { steps: 1 })], DAY)).toEqual([]);
  });
});

describe('latestMood', () => {
  it('returns the check-in with the newest checkinAt', () => {
    const older = mood(DAY, '2026-06-15T05:00:00.000Z', [-1, 0, 7]);
    const newer = mood(DAY, '2026-06-15T07:30:00.000Z', [2, 1, 6.5]);
    expect(latestMood([older, newer])).toEqual({ mood: 2, energy: 1, sleep: 6.5 });
    expect(latestMood([newer, older])).toEqual({ mood: 2, energy: 1, sleep: 6.5 });
  });

  it('is null when there is no check-in', () => {
    expect(latestMood([])).toBeNull();
  });
});

describe('recentTraining', () => {
  it('counts sessions in the 7 days ending on the brief day, distinct dates only, ignoring free text', () => {
    const note = 'SENTINEL-NOTE';
    const rows = [
      trow(BEFORE_WINDOW, note),
      trow('2026-06-09', note),
      trow('2026-06-09', note),
      trow(DAY, note),
      trow(FUTURE, note),
    ];
    const result = recentTraining(rows, DAY);
    expect(result).toEqual({ count: 3, dates: ['2026-06-09', DAY] });
    expect(JSON.stringify(result)).not.toContain(note);
  });

  it('empty input is count 0 with no dates', () => {
    expect(recentTraining([], DAY)).toEqual({ count: 0, dates: [] });
  });
});

describe('toWeatherWindows', () => {
  it('picks the lowest-rain window on the brief day via chooseRunWindow', () => {
    const points = briefDayPoints((h) => ({ rainMm: h === 18 || h === 19 ? 0 : 1 }));
    const windows = toWeatherWindows([model(points)], DAY, TZ);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ day: DAY, start: '2026-06-15T16:00:00.000Z', end: '2026-06-15T18:00:00.000Z', rainMm: 0 });
  });

  it('is empty when the models have no points on the brief day', () => {
    const otherDay = [wp('2026-06-16T06:00:00.000Z'), wp('2026-06-16T07:00:00.000Z')];
    expect(toWeatherWindows([model(otherDay)], DAY, TZ)).toEqual([]);
  });

  it('is empty when there are no models', () => {
    expect(toWeatherWindows([], DAY, TZ)).toEqual([]);
  });
});

describe('gatherCandidates', () => {
  const baseline = Array.from({ length: 20 }, () => hday('2026-05-01', { steps: 1000 }));
  const deps = (over: Partial<MorningBriefGatherDeps> = {}): MorningBriefGatherDeps => ({
    day: DAY,
    readTasks: async () => tasksResponse([task('open', 'Alpha', DAY)]),
    readHealthHistory: async () => healthResponse(baseline),
    readTraining: async () => trainingResponse([trow(DAY, '')]),
    readWeather: async () => weatherResponse([model(briefDayPoints())]),
    readMood: async () => [mood(DAY, '2026-06-15T07:00:00.000Z', [1, 1, 7])],
    ...over,
  });

  it('assembles every slot from the injected readers', async () => {
    const result = await gatherCandidates(deps());
    expect(result.todos).toEqual([{ text: 'Alpha', due: DAY, bill: false }]);
    expect(result.metrics).toHaveLength(4);
    expect(result.mood).toEqual({ mood: 1, energy: 1, sleep: 7 });
    expect(result.trainingRecent).toEqual({ count: 1, dates: [DAY] });
    expect(result.weatherWindows).toHaveLength(1);
    expect(result.unavailable).toEqual([]);
  });

  it('a throwing reader lands in unavailable without rejecting; other slots still return', async () => {
    const sentinel = 'SENTINEL-THROW';
    const result = await gatherCandidates(deps({ readTasks: async () => Promise.reject(new Error(sentinel)) }));
    expect(result.unavailable).toEqual(['tasks']);
    expect(result.todos).toEqual([]);
    expect(result.metrics).toHaveLength(4);
    expect(result.mood).toEqual({ mood: 1, energy: 1, sleep: 7 });
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('an ApiError reader lands in unavailable and leaves its slot empty', async () => {
    const result = await gatherCandidates(deps({ readWeather: async () => ({ code: 'upstream-unavailable', message: 'no weather', retryable: true }) }));
    expect(result.unavailable).toEqual(['weather']);
    expect(result.weatherWindows).toEqual([]);
    expect(result.todos).toHaveLength(1);
  });

  it('empty readers produce an empty result, not an error', async () => {
    const result = await gatherCandidates(deps({
      readTasks: async () => tasksResponse([]),
      readHealthHistory: async () => healthResponse([]),
      readTraining: async () => trainingResponse([]),
      readWeather: async () => weatherResponse([]),
      readMood: async () => [],
    }));
    expect(result).toEqual({ todos: [], metrics: [], mood: null, trainingRecent: { count: 0, dates: [] }, weatherWindows: [], unavailable: [] });
  });

  it('a non-ok union status is an honest empty slot, not a gatherer failure', async () => {
    const result = await gatherCandidates(deps({
      readTraining: async () => ({ status: 'absent', revision: SHA }),
      readWeather: async () => ({ status: 'unavailable', now: '2026-06-15T05:00:00Z', location: { label: 'Copenhagen city centre (coarse fallback)', latitude: 55.68, longitude: 12.57, precision: 'city-fallback', timeZone: 'Europe/Copenhagen' }, reason: 'no-data', message: 'No weather model returned usable forecast points.' }),
    }));
    expect(result.trainingRecent).toEqual({ count: 0, dates: [] });
    expect(result.weatherWindows).toEqual([]);
    expect(result.unavailable).toEqual([]);
  });
});

