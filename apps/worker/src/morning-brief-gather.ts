// Morning Brief candidate gatherers (MB1b). Read-only: turns projections the app ALREADY reads into MB1a day-model
// inputs. The mappers are pure and synchronous; `gatherCandidates` is the only async reader and never throws: a reader
// that fails yields an empty slot plus its name in `unavailable`. No task/note text or metric values leave this module.
import {
  type ApiError,
  type HealthHistoryDay,
  type HealthHistoryResponse,
  type HealthMetric,
  type HealthMetricKey,
  type MoodCheckinPayload,
  type TaskView,
  type TasksResponse,
  type TrainingResponse,
  type TrainingRow,
  type WeatherModelSeries,
  type WeatherResponse,
  type WeatherRunWindow,
  WEATHER_TIME_ZONE,
} from '@vault-companion/contracts';
import { chooseRunWindow, type BriefEvent, type BriefTodo, type MoodSnapshot } from '@vault-companion/domain';
import type { GoogleMailItem } from './google-reader.ts';

/** Same shape the API layer uses to tell a projection from a typed error. */
const isApiError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;

/** Counts and dates only: a TrainingRow's free text (type/note/...) is never copied. */
export interface TrainingRecent {
  /** Sessions dated in the last 7 days ending on the brief day. */
  readonly count: number;
  /** Distinct session dates in that window, ascending. */
  readonly dates: string[];
}

export interface MorningBriefCandidates {
  readonly todos: BriefTodo[];
  readonly events: BriefEvent[];
  readonly metrics: HealthMetric[];
  readonly mood: MoodSnapshot | null;
  readonly trainingRecent: TrainingRecent;
  readonly weatherWindows: WeatherRunWindow[];
  /** Names of the readers that failed (ApiError or throw); the other slots still hold their values. */
  readonly unavailable: string[];
}

export interface MorningBriefGatherDeps {
  /** Brief day in the user's local calendar (YYYY-MM-DD); the weather window and the training window key off it. */
  readonly day: string;
  readonly timeZone?: string;
  readonly readTasks: () => Promise<TasksResponse | ApiError>;
  readonly readHealthHistory: () => Promise<HealthHistoryResponse | ApiError>;
  readonly readTraining: () => Promise<TrainingResponse | ApiError>;
  readonly readWeather: () => Promise<WeatherResponse | ApiError>;
  /** The check-ins this device holds (ADR-0036); the newest one is the mood snapshot. */
  readonly readMood: () => Promise<readonly MoodCheckinPayload[] | ApiError>;
  /** ADR-0044: today's local calendar events (metadata only). */
  readonly readCalendar: () => Promise<readonly BriefEvent[] | ApiError>;
  /** ADR-0044: today's Jev-labelled inbox mail (metadata only). */
  readonly readMail: () => Promise<readonly GoogleMailItem[] | ApiError>;
}

// ---- Tasks ----

/**
 * Open tasks only, in read order. `bill` is always false: TasksResponse/TaskView carry no bill or payment marker, so
 * there is nothing honest to copy and no heuristic is applied (owner brief MB1b).
 */
export function toBriefTodos(tasks: readonly TaskView[]): BriefTodo[] {
  const todos: BriefTodo[] = [];
  for (const task of tasks) {
    if (task.status !== 'open') continue;
    todos.push({ text: task.description, due: task.due, bill: false });
  }
  return todos;
}

/** Mail metadata becomes the only mail text the writer may see: one todo line per Jev label item. */
export function toMailTodos(mail: readonly GoogleMailItem[]): BriefTodo[] {
  const prefix: Record<GoogleMailItem['label'], string> = {
    deadline: 'Deadline',
    payment: 'Pay',
    'needs-reply': 'Reply',
  };
  return mail.map((item) => ({
    text: `${prefix[item.label]}: ${item.subject} (${item.sender})`,
    due: null,
    bill: item.label === 'payment' || item.label === 'deadline',
  }));
}

// ---- Health ----

const METRIC_KEYS: readonly HealthMetricKey[] = ['steps', 'headphone_min', 'first_move', 'last_move'];
/** Same derivation as the HC1 card (packages/domain/src/health.ts); the history view exposes the raw rows, not metrics. */
const BASELINE_DAYS = 90;
const SERIES_DAYS = 30;
const MIN_BASELINE_VALUES = 14;
const TIME_KEYS: ReadonlySet<HealthMetricKey> = new Set(['first_move', 'last_move']);
const TIME_TOLERANCE_MINUTES = 30;

function epochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

function shiftDays(date: string, days: number): string {
  return new Date((epochDay(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function compareMetric(value: number | null, baseline: number | null, key: HealthMetricKey): HealthMetric['compare'] {
  if (value === null || baseline === null) return 'unknown';
  const tolerance = TIME_KEYS.has(key) ? TIME_TOLERANCE_MINUTES : Math.abs(baseline) * 0.1;
  if (Math.abs(value - baseline) <= tolerance) return 'usual';
  return value > baseline ? 'above' : 'below';
}

/**
 * The newest history day at or before `briefDay`, turned into the four HealthMetric rows `stateLine` consumes. Returns
 * `[]` when the history is empty or has no day in range: a missing day is not a zero.
 */
export function toHealthMetrics(days: readonly HealthHistoryDay[], briefDay: string): HealthMetric[] {
  const byDate = new Map<string, HealthHistoryDay>();
  let day: HealthHistoryDay | undefined;
  for (const row of days) {
    byDate.set(row.date, row);
    if (row.date <= briefDay && (!day || row.date > day.date)) day = row;
  }
  if (!day) return [];

  const shown = day;
  return METRIC_KEYS.map((key) => {
    const value = shown[key];
    const baselineValues: number[] = [];
    for (let i = 1; i <= BASELINE_DAYS; i++) {
      const prior = byDate.get(shiftDays(shown.date, -i))?.[key] ?? null;
      if (prior !== null) baselineValues.push(prior);
    }
    const baseline = baselineValues.length >= MIN_BASELINE_VALUES ? median(baselineValues) : null;
    const series: (number | null)[] = [];
    for (let i = SERIES_DAYS - 1; i >= 0; i--) series.push(byDate.get(shiftDays(shown.date, -i))?.[key] ?? null);
    return { key, value, baseline, compare: compareMetric(value, baseline, key), series };
  });
}

// ---- Mood ----

/** The check-in with the newest `checkinAt` (ties keep the first seen); null when there is none. */
export function latestMood(checkins: readonly MoodCheckinPayload[]): MoodSnapshot | null {
  let best: MoodCheckinPayload | undefined;
  for (const checkin of checkins) if (!best || checkin.checkinAt > best.checkinAt) best = checkin;
  return best ? { mood: best.mood, energy: best.energy, sleep: best.sleep } : null;
}

// ---- Training ----

const TRAINING_WINDOW_DAYS = 7;

/** Sessions in the 7 local days ending on `briefDay`: a total count and the distinct dates. */
export function recentTraining(rows: readonly TrainingRow[], briefDay: string): TrainingRecent {
  const from = shiftDays(briefDay, -(TRAINING_WINDOW_DAYS - 1));
  const dates = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (row.date < from || row.date > briefDay) continue;
    count += 1;
    dates.add(row.date);
  }
  return { count, dates: [...dates].sort() };
}

// ---- Weather ----

/**
 * The lowest-rain two-hour window on the brief day, chosen by the domain's `chooseRunWindow` (never reimplemented).
 * At most one window today; a list leaves room for later days. No mm threshold is invented: the window is the
 * lowest-rain candidate, not a dry-weather guarantee.
 */
export function toWeatherWindows(models: readonly WeatherModelSeries[], briefDay: string, timeZone: string): WeatherRunWindow[] {
  const window = chooseRunWindow(models, briefDay, timeZone);
  return window ? [window] : [];
}

// ---- Gatherer ----

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** Invoke a reader exactly once; an ApiError or a throw is a failure, never a rethrow. */
async function settle<T>(read: () => Promise<T | ApiError>): Promise<Settled<T>> {
  try {
    const value = await read();
    return isApiError(value) ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Read every injected source in parallel and map it to the MB1a inputs. Deterministic for fixed input; a failing
 * reader contributes an empty slot and its name to `unavailable`, and never affects the other slots.
 */
export async function gatherCandidates(deps: MorningBriefGatherDeps): Promise<MorningBriefCandidates> {
  const timeZone = deps.timeZone ?? WEATHER_TIME_ZONE;
  const [tasks, health, training, weather, mood, calendar, mail] = await Promise.all([
    settle(deps.readTasks),
    settle(deps.readHealthHistory),
    settle(deps.readTraining),
    settle(deps.readWeather),
    settle(deps.readMood),
    settle(deps.readCalendar),
    settle(deps.readMail),
  ]);

  const unavailable: string[] = [];
  const todos = [...(tasks.ok ? toBriefTodos(tasks.value.allOpen) : []), ...(mail.ok ? toMailTodos(mail.value) : [])];
  if (!tasks.ok) unavailable.push('tasks');
  const events = calendar.ok ? [...calendar.value] : [];
  const metrics = health.ok ? toHealthMetrics(health.value.days, deps.day) : [];
  if (!health.ok) unavailable.push('health');
  const trainingRecent = training.ok && training.value.status === 'ok' ? recentTraining(training.value.rows, deps.day) : { count: 0, dates: [] };
  if (!training.ok) unavailable.push('training');
  const weatherWindows = weather.ok && weather.value.status === 'ok' ? toWeatherWindows(weather.value.projection.models, deps.day, timeZone) : [];
  if (!weather.ok) unavailable.push('weather');
  const moodSnapshot = mood.ok ? latestMood(mood.value) : null;
  if (!mood.ok) unavailable.push('mood');
  if (!calendar.ok) unavailable.push('calendar');
  if (!mail.ok) unavailable.push('mail');

  return { todos, events, metrics, mood: moodSnapshot, trainingRecent, weatherWindows, unavailable };
}
