// HC1: read-only health card over ONE fixed Apple Health daily export. Nothing here accepts a path, and no cell text
// ever leaves this module in an error, log or message (privacy invariant). Values are derived numbers only.
import {
  HEALTH_DAILY_CSV,
  type ApiError,
  type HealthCompare,
  type HealthMetric,
  type HealthMetricKey,
  type HealthResponse,
} from '@vault-companion/contracts';
import { isStructurallySafePath } from './paths.ts';
import { DEFAULT_USER_TIME_ZONE, userDate } from './time.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

export interface HealthServiceDeps {
  readonly store: VaultStore;
  readonly now?: () => Date;
  readonly timeZone?: string;
}

/** > 1 MB matches the adapter's byte-fidelity bound; a bigger export is unreadable here. */
const MAX_HEALTH_BYTES = 1024 * 1024;
const BASELINE_DAYS = 90;
const SERIES_DAYS = 30;
const MIN_BASELINE_VALUES = 14;
/** Times before 03:00 belong to the behavioural day; shift so medians never wrap midnight. */
const DAY_BOUNDARY_MINUTES = 3 * 60;

/** The one fixed source. A constant, never client input; guarded structurally (the note-path policy does not cover CSV). */
const PATH: VaultPath | null = isStructurallySafePath(HEALTH_DAILY_CSV) ? (HEALTH_DAILY_CSV as VaultPath) : null;

const METRIC_KEYS: readonly HealthMetricKey[] = ['steps', 'headphone_min', 'first_move', 'last_move'];
const REQUIRED_COLUMNS = ['date', 'steps', 'headphone_min', 'first_move', 'last_move'] as const;
const TIME_KEYS: ReadonlySet<HealthMetricKey> = new Set(['first_move', 'last_move']);

interface DayRow {
  readonly date: string;
  readonly steps: number | null;
  readonly headphone: number | null;
  readonly first: number | null;
  readonly last: number | null;
}

function epochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

function addDays(date: string, n: number): string {
  return new Date((epochDay(date) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Minimal CSV field splitter: quoted fields (with "" escapes) are honoured, but cells here never contain commas. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCount(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/** `HH:MM` -> minutes after 03:00 (`01:30` -> 1350, `03:00` -> 0). Empty or malformed -> null. */
function parseTime(raw: string | undefined): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]!);
  const min = Number(m[2]!);
  if (h > 23 || min > 59) return null;
  return (h * 60 + min - DAY_BOUNDARY_MINUTES + 1440) % 1440;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function compare(value: number | null, baseline: number | null, key: HealthMetricKey): HealthCompare {
  if (value === null || baseline === null) return 'unknown';
  const tolerance = TIME_KEYS.has(key) ? 30 : Math.abs(baseline) * 0.1;
  if (Math.abs(value - baseline) <= tolerance) return 'usual';
  return value > baseline ? 'above' : 'below';
}

function valueOf(row: DayRow | undefined, key: HealthMetricKey): number | null {
  if (!row) return null;
  if (key === 'steps') return row.steps;
  if (key === 'headphone_min') return row.headphone;
  if (key === 'first_move') return row.first;
  return row.last;
}

/** Header names -> rows, or `null` when a column this card needs is absent (unreadable). */
function parseRows(text: string): Map<string, DayRow> | null {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  const header = splitLine(lines[0]!).map((h) => h.trim());
  const index = new Map(header.map((name, i) => [name, i]));
  if (REQUIRED_COLUMNS.some((c) => !index.has(c))) return null;
  const rows = new Map<string, DayRow>();
  for (const line of lines.slice(1)) {
    const cells = splitLine(line);
    const date = (cells[index.get('date')!] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const steps = parseCount(cells[index.get('steps')!]);
    const firstRaw = (cells[index.get('first_move')!] ?? '').trim();
    const headphone = parseCount(cells[index.get('headphone_min')!]);
    const first = parseTime(firstRaw);
    const last = parseTime(cells[index.get('last_move')!]);
    // An exporter's "no data" sentinel: steps 0 AND no first move. Null everywhere, and never in a baseline.
    const noData = steps === 0 && firstRaw === '';
    rows.set(date, {
      date,
      steps: noData ? null : steps,
      headphone: noData ? null : headphone,
      first: noData ? null : first,
      last: noData ? null : last,
    });
  }
  return rows;
}

async function readHealth(deps: Required<Pick<HealthServiceDeps, 'store' | 'now' | 'timeZone'>>): Promise<HealthResponse | ApiError> {
  const { store } = deps;
  try {
    const { commitSha: revision } = await store.head();
    const at = deps.now();
    const now = at.toISOString();
    const unreadable: HealthResponse = { revision, now, status: 'unreadable', metrics: [] };
    const missing: HealthResponse = { revision, now, status: 'missing', metrics: [] };
    if (!PATH) return unreadable;

    const listed = (await store.listFiles('Health/Data', revision)).find((f) => f.path === PATH);
    if (!listed) return missing;
    const file = await store.readFile(PATH, revision);
    if (!file || file.blobSha !== listed.blobSha) return unreadable;
    if (file.bytes.length > MAX_HEALTH_BYTES) return unreadable;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
    } catch {
      return unreadable;
    }
    const rows = parseRows(text);
    if (!rows) return unreadable;

    const yesterday = addDays(userDate(at, deps.timeZone), -1);
    let day: string | undefined;
    for (const date of rows.keys()) if (date <= yesterday && (day === undefined || date > day)) day = date;
    if (day === undefined) return missing;

    const metrics: HealthMetric[] = METRIC_KEYS.map((key) => {
      const value = valueOf(rows.get(day), key);
      const baselineValues: number[] = [];
      for (let i = 1; i <= BASELINE_DAYS; i++) {
        const v = valueOf(rows.get(addDays(day, -i)), key);
        if (v !== null) baselineValues.push(v);
      }
      const baseline = baselineValues.length >= MIN_BASELINE_VALUES ? median(baselineValues) : null;
      const series: (number | null)[] = [];
      for (let i = SERIES_DAYS - 1; i >= 0; i--) series.push(valueOf(rows.get(addDays(day, -i)), key));
      return { key, value, baseline, compare: compare(value, baseline, key), series };
    });
    return { revision, now, status: 'ok', day, staleDays: epochDay(yesterday) - epochDay(day), metrics };
  } catch (e) {
    if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
      return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
    }
    throw e;
  }
}

export function createHealthService(deps: HealthServiceDeps) {
  const resolved = { store: deps.store, now: deps.now ?? (() => new Date()), timeZone: deps.timeZone ?? DEFAULT_USER_TIME_ZONE };
  return {
    readHealth(): Promise<HealthResponse | ApiError> {
      return readHealth(resolved);
    },
  };
}
