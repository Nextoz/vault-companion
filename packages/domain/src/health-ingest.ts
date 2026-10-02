import { HEALTH_DAILY_CSV, type ErrorCode } from '@vault-companion/contracts';
import { executeWrite, type Planned, type WritePlan } from './execute.ts';
import { isStructurallySafePath } from './paths.ts';
import { DEFAULT_USER_TIME_ZONE, userDate } from './time.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

/** The one fixed write target, same constant as the read-only health card. */
const PATH: VaultPath | null = isStructurallySafePath(HEALTH_DAILY_CSV) ? (HEALTH_DAILY_CSV as VaultPath) : null;
const HEADER =
  'date,weekday,steps,distance_km,flights,active_kcal,walking_speed_kmh,first_move,last_move,late_steps,early_steps,headphone_min,headphone_db,loud_min,in_bed_h';

const MAX_SPAN_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_FILE_BYTES = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

export interface HealthIngestDeps {
  readonly store: VaultStore;
  readonly now?: () => Date;
  readonly timeZone?: string;
}

export type HealthIngestOutcome =
  | { readonly ok: true; readonly days: readonly string[]; readonly commitSha: string }
  | { readonly ok: false; readonly status: 400 | 409 | 413 | 422 | 503; readonly error: string };

type FieldName = 'steps' | 'distance' | 'flights' | 'activeEnergy' | 'walkingSpeed' | 'headphone' | 'sleep';
const FIELD_NAMES: readonly FieldName[] = ['steps', 'distance', 'flights', 'activeEnergy', 'walkingSpeed', 'headphone', 'sleep'];
const UNITS: Readonly<Record<FieldName, string>> = {
  steps: 'count',
  distance: 'km',
  flights: 'count',
  activeEnergy: 'kcal',
  walkingSpeed: 'km/hr',
  headphone: 'dBASPL',
  sleep: '',
};

interface Payload {
  readonly from: Date;
  readonly sentAt: Date;
  readonly fields: Readonly<Record<FieldName, string>>;
}

interface NumericSample {
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

interface SleepSample {
  readonly start: number;
  readonly end: number;
  readonly inBed: boolean;
}

interface Samples {
  readonly steps: readonly NumericSample[];
  readonly distance: readonly NumericSample[];
  readonly flights: readonly NumericSample[];
  readonly activeEnergy: readonly NumericSample[];
  readonly walkingSpeed: readonly NumericSample[];
  readonly headphone: readonly NumericSample[];
  readonly sleep: readonly SleepSample[];
}

interface DayAgg {
  steps: number;
  distance: number;
  flights: number;
  activeKcal: number;
  speedSum: number;
  speedCount: number;
  headphoneMin: number;
  headphoneEnergy: number;
  headphoneLoud: number;
  inBedHours: number;
  lateSteps: number;
  earlySteps: number;
  firstMove: number | null;
  lastMove: number | null;
}

type Effect = { readonly days: readonly string[] };

const err = (status: 400 | 409 | 413 | 422 | 503, error: string): HealthIngestOutcome => ({ ok: false, status, error });

function parseIso(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parsePayload(body: string, now: Date): { ok: true; payload: Payload } | { ok: false; status: 400; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: 'body is not JSON' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'invalid health ingest payload' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return { ok: false, status: 400, error: 'invalid schemaVersion' };
  const from = parseIso(obj.from);
  if (!from) return { ok: false, status: 400, error: 'invalid from' };
  const sentAt = parseIso(obj.sentAt);
  if (!sentAt) return { ok: false, status: 400, error: 'invalid sentAt' };
  if (!(from.getTime() < sentAt.getTime())) return { ok: false, status: 400, error: 'invalid from' };
  if (sentAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return { ok: false, status: 400, error: 'invalid sentAt' };
  if (sentAt.getTime() - from.getTime() > MAX_SPAN_MS) return { ok: false, status: 400, error: 'invalid timespan' };

  const fields = {} as Record<FieldName, string>;
  for (const field of FIELD_NAMES) {
    const value = obj[field];
    if (value === undefined) fields[field] = '';
    else if (typeof value === 'string') fields[field] = value;
    else return { ok: false, status: 400, error: `invalid ${field}` };
  }
  return { ok: true, payload: { from, sentAt, fields } };
}

function fieldFailure(field: FieldName, line: number): { ok: false; error: string } {
  return { ok: false, error: `invalid ${field} line ${line}` };
}

function splitFieldLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function parseNumericField(field: FieldName, text: string, integer: boolean): { ok: true; samples: NumericSample[] } | { ok: false; error: string } {
  const samples: NumericSample[] = [];
  const lines = splitFieldLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const lineNo = i + 1;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length !== 4) return fieldFailure(field, lineNo);
    const start = parseIso(parts[0]);
    if (!start) return fieldFailure(field, lineNo);
    const end = parseIso(parts[1]);
    if (!end) return fieldFailure(field, lineNo);
    if (parts[3] !== UNITS[field]) return fieldFailure(field, lineNo);
    const rawValue = parts[2]!;
    let value: number;
    if (integer) {
      if (!/^\d+$/.test(rawValue)) return fieldFailure(field, lineNo);
      value = Number(rawValue);
      if (!Number.isSafeInteger(value)) return fieldFailure(field, lineNo);
    } else {
      if (!/^\d+(?:[.,]\d+)?$/.test(rawValue)) return fieldFailure(field, lineNo);
      value = Number(rawValue.replace(',', '.'));
      if (!Number.isFinite(value)) return fieldFailure(field, lineNo);
    }
    samples.push({ start: start.getTime(), end: end.getTime(), value });
  }
  return { ok: true, samples };
}

function parseSleepField(text: string): { ok: true; samples: SleepSample[] } | { ok: false; error: string } {
  const samples: SleepSample[] = [];
  const lines = splitFieldLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const lineNo = i + 1;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length !== 4) return fieldFailure('sleep', lineNo);
    const start = parseIso(parts[0]);
    if (!start) return fieldFailure('sleep', lineNo);
    const end = parseIso(parts[1]);
    if (!end) return fieldFailure('sleep', lineNo);
    if (parts[3] !== '') return fieldFailure('sleep', lineNo);
    samples.push({ start: start.getTime(), end: end.getTime(), inBed: parts[2]!.toLowerCase() === 'in bed' });
  }
  return { ok: true, samples };
}

function parseSamples(fields: Payload['fields']): { ok: true; samples: Samples } | { ok: false; status: 400; error: string } {
  const steps = parseNumericField('steps', fields.steps, true);
  if (!steps.ok) return { ok: false, status: 400, error: steps.error };
  const distance = parseNumericField('distance', fields.distance, false);
  if (!distance.ok) return { ok: false, status: 400, error: distance.error };
  const flights = parseNumericField('flights', fields.flights, true);
  if (!flights.ok) return { ok: false, status: 400, error: flights.error };
  const activeEnergy = parseNumericField('activeEnergy', fields.activeEnergy, false);
  if (!activeEnergy.ok) return { ok: false, status: 400, error: activeEnergy.error };
  const walkingSpeed = parseNumericField('walkingSpeed', fields.walkingSpeed, false);
  if (!walkingSpeed.ok) return { ok: false, status: 400, error: walkingSpeed.error };
  const headphone = parseNumericField('headphone', fields.headphone, false);
  if (!headphone.ok) return { ok: false, status: 400, error: headphone.error };
  const sleep = parseSleepField(fields.sleep);
  if (!sleep.ok) return { ok: false, status: 400, error: sleep.error };
  return {
    ok: true,
    samples: {
      steps: steps.samples,
      distance: distance.samples,
      flights: flights.samples,
      activeEnergy: activeEnergy.samples,
      walkingSpeed: walkingSpeed.samples,
      headphone: headphone.samples,
      sleep: sleep.samples,
    },
  };
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + n * 86_400_000).toISOString().slice(0, 10);
}

function dateList(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

function isLocalMidnight(instant: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '0';
  return value('hour') === '00' && value('minute') === '00' && value('second') === '00' && value('fractionalSecond') === '000';
}

function localHour(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
}

/** Calendar date of the Copenhagen wall-clock time shifted by `shiftHours` (not absolute time). */
function wallClockDate(ms: number, timeZone: string, shiftHours: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const shifted = new Date(
    Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') + shiftHours, value('minute'), value('second'), value('fractionalSecond')),
  );
  return shifted.toISOString().slice(0, 10);
}

function formatHm(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

function weekday(date: string, timeZone: string): string {
  const instant = new Date(`${date}T00:00:00Z`);
  // The date string is a calendar date, so its weekday is timezone-independent; format the UTC-midnight
  // instant as UTC, never in the user zone (behind-UTC zones would otherwise get the previous day).
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(instant);
}

/** Python-style banker's rounding, then formatting with no trailing zeros. */
function roundHalfEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floored = Math.floor(scaled);
  const fraction = scaled - floored;
  let rounded: number;
  if (fraction < 0.5) rounded = floored;
  else if (fraction > 0.5) rounded = floored + 1;
  else rounded = floored % 2 === 0 ? floored : floored + 1;
  return rounded / factor;
}

function formatNumber(value: number, decimals: number): string {
  const rounded = roundHalfEven(value, decimals);
  if (decimals === 0) return String(rounded);
  let out = rounded.toFixed(decimals);
  out = out.replace(/0+$/, '').replace(/\.$/, '');
  return out;
}

function newAgg(): DayAgg {
  return {
    steps: 0,
    distance: 0,
    flights: 0,
    activeKcal: 0,
    speedSum: 0,
    speedCount: 0,
    headphoneMin: 0,
    headphoneEnergy: 0,
    headphoneLoud: 0,
    inBedHours: 0,
    lateSteps: 0,
    earlySteps: 0,
    firstMove: null,
    lastMove: null,
  };
}

function aggregate(payload: Payload, timeZone: string): { ok: true; aggs: ReadonlyMap<string, DayAgg>; days: string[] } | { ok: false; status: 400 | 422; error: string } {
  const parsed = parseSamples(payload.fields);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { samples } = parsed;
  if (samples.steps.length === 0) return { ok: false, status: 422, error: 'Health was locked: no step samples' };

  const aggs = new Map<string, DayAgg>();
  const get = (date: string): DayAgg => {
    let agg = aggs.get(date);
    if (!agg) {
      agg = newAgg();
      aggs.set(date, agg);
    }
    return agg;
  };

  const calendar = (ms: number) => userDate(new Date(ms), timeZone);
  const behavioural = (ms: number) => wallClockDate(ms, timeZone, -3);

  for (const sample of samples.steps) {
    const date = calendar(sample.start);
    const agg = get(date);
    agg.steps += sample.value;
    const hour = localHour(sample.start, timeZone);
    if (hour < 3) get(addDays(date, -1)).lateSteps += sample.value;
    else if (hour < 6) agg.earlySteps += sample.value;
    if (sample.value >= 20) {
      const day = behavioural(sample.start);
      const move = get(day);
      move.firstMove = move.firstMove === null ? sample.start : Math.min(move.firstMove, sample.start);
      move.lastMove = move.lastMove === null ? sample.end : Math.max(move.lastMove, sample.end);
    }
  }

  for (const sample of samples.distance) get(calendar(sample.start)).distance += sample.value;
  for (const sample of samples.flights) get(calendar(sample.start)).flights += sample.value;
  for (const sample of samples.activeEnergy) get(calendar(sample.start)).activeKcal += sample.value;
  for (const sample of samples.walkingSpeed) {
    const agg = get(calendar(sample.start));
    agg.speedSum += sample.value;
    agg.speedCount++;
  }
  for (const sample of samples.headphone) {
    const agg = get(calendar(sample.start));
    const mins = Math.max(sample.end - sample.start, 0) / 60_000;
    agg.headphoneMin += mins;
    agg.headphoneEnergy += mins * 10 ** (sample.value / 10);
    if (sample.value >= 80) agg.headphoneLoud += mins;
  }
  for (const sample of samples.sleep) {
    if (!sample.inBed) continue;
    const day = behavioural(sample.end);
    get(day).inBedHours += Math.max(sample.end - sample.start, 0) / HOUR_MS;
  }

  const fromDate = calendar(payload.from.getTime());
  const startDate = isLocalMidnight(payload.from, timeZone) ? fromDate : addDays(fromDate, 1);
  const sentDate = calendar(payload.sentAt.getTime());
  const days = dateList(startDate, sentDate).filter((date) => aggs.has(date));
  return { ok: true, aggs, days };
}

function formatDay(date: string, agg: DayAgg, timeZone: string): string {
  return [
    date,
    weekday(date, timeZone),
    formatNumber(agg.steps, 0),
    formatNumber(agg.distance, 2),
    formatNumber(agg.flights, 0),
    formatNumber(agg.activeKcal, 0),
    agg.speedCount > 0 ? formatNumber(agg.speedSum / agg.speedCount, 2) : '',
    agg.firstMove === null ? '' : formatHm(agg.firstMove, timeZone),
    agg.lastMove === null ? '' : formatHm(agg.lastMove, timeZone),
    formatNumber(agg.lateSteps, 0),
    formatNumber(agg.earlySteps, 0),
    formatNumber(agg.headphoneMin, 0),
    agg.headphoneMin > 0 ? formatNumber(10 * Math.log10(agg.headphoneEnergy / agg.headphoneMin), 1) : '',
    formatNumber(agg.headphoneLoud, 0),
    agg.inBedHours > 0 ? formatNumber(agg.inBedHours, 1) : '',
  ].join(',');
}

function splitCsvLine(line: string): string[] {
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

type MergeResult = { ok: true; text: string } | { ok: false; code: ErrorCode; message: string };

function mergeCsv(body: string, aggs: ReadonlyMap<string, DayAgg>, days: readonly string[], timeZone: string): MergeResult {
  const firstEol = /(\r\n|\r|\n)/.exec(body);
  const eol = firstEol?.[1] ?? '\n';
  const rawLines = body.split(/\r\n|\r|\n/);
  if (rawLines.length > 0 && rawLines.at(-1) === '') rawLines.pop();
  if (rawLines[0] !== HEADER) return { ok: false, code: 'refused:structure', message: 'health file has an unexpected structure' };

  interface LineRef { raw: string; date: string | null }
  const items: LineRef[] = [{ raw: rawLines[0]!, date: null }];
  for (const raw of rawLines.slice(1)) {
    if (raw.trim() === '') { items.push({ raw, date: null }); continue; }
    const date = (splitCsvLine(raw)[0] ?? '').trim();
    items.push({ raw, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null });
  }

  for (const date of days) {
    const agg = aggs.get(date);
    if (!agg) continue;
    const line = formatDay(date, agg, timeZone);
    const existing = items.findIndex((item, i) => i > 0 && item.date === date);
    if (existing !== -1) items[existing] = { raw: line, date };
    else {
      const insertAt = items.findIndex((item, i) => i > 0 && item.date !== null && item.date > date);
      items.splice(insertAt === -1 ? items.length : insertAt, 0, { raw: line, date });
    }
  }

  const hasFinalNewline = body.endsWith('\n') || body.endsWith('\r');
  return { ok: true, text: `${items.map((item) => item.raw).join(eol)}${hasFinalNewline ? eol : ''}` };
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function planFor(payload: Payload, aggs: ReadonlyMap<string, DayAgg>, days: readonly string[], timeZone: string): WritePlan<Effect> {
  return {
    message: 'health: ingest daily rows',
    async compute(store, atCommit): Promise<Planned<Effect>> {
      if (!PATH) return { ok: false, code: 'refused:structure', message: 'health file has an unexpected structure' };
      let file;
      try {
        file = await store.readFile(PATH, atCommit);
      } catch (e) {
        if (e instanceof FileTooLarge) return { ok: false, code: 'refused:too-large', message: 'health file is too large to edit safely' };
        throw e;
      }
      if (!file) return { ok: false, code: 'refused:structure', message: 'health file was not found' };
      if (file.bytes.length > MAX_FILE_BYTES) return { ok: false, code: 'refused:too-large', message: 'health file is too large to edit safely' };

      const text = decodeUtf8(file.bytes);
      if (text === null) return { ok: false, code: 'refused:encoding', message: 'health file is not valid UTF-8' };
      const bom = text.startsWith('\uFEFF');
      const body = bom ? text.slice(1) : text;
      const merged = mergeCsv(body, aggs, days, timeZone);
      if (!merged.ok) return { ok: false, code: merged.code, message: merged.message };
      const bytes = new TextEncoder().encode(`${bom ? '\uFEFF' : ''}${merged.text}`);
      return { ok: true, path: PATH, expect: 'regular-file', bytes, effect: { days } };
    },
  };
}

function plannedFailure(planned: Planned<Effect>): HealthIngestOutcome {
  if (!planned.ok) {
    if (planned.code === 'refused:structure' || planned.code === 'refused:encoding' || planned.code === 'refused:too-large') {
      return err(409, planned.message);
    }
    return err(400, planned.message);
  }
  throw new Error('unreachable');
}

function executeFailure(message: string, code: string): HealthIngestOutcome {
  if (code === 'upstream-unavailable') return err(503, 'GitHub is not reachable right now');
  if (code === 'conflict:stale') return err(503, message);
  return err(409, message);
}

export function createHealthIngestService(deps: HealthIngestDeps) {
  const now = deps.now ?? (() => new Date());
  const timeZone = deps.timeZone ?? DEFAULT_USER_TIME_ZONE;
  const store = deps.store;

  return {
    async ingestHealth(body: string): Promise<HealthIngestOutcome> {
      const parsed = parsePayload(body, now());
      if (!parsed.ok) return err(parsed.status, parsed.error);
      const payload = parsed.payload;

      const result = aggregate(payload, timeZone);
      if (!result.ok) return err(result.status, result.error);
      const { aggs, days } = result;
      const plan = planFor(payload, aggs, days, timeZone);

      let revision: string;
      try {
        revision = (await store.head()).commitSha;
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return err(503, 'GitHub is not reachable right now');
        throw e;
      }

      try {
        const planned = await plan.compute(store, revision);
        if (!planned.ok) return plannedFailure(planned);
        const current = await store.readFile(planned.path, revision);
        if (current && bytesEqual(current.bytes, planned.bytes)) return { ok: true, days, commitSha: revision };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return err(503, 'GitHub is not reachable right now');
        if (e instanceof FileTooLarge) return err(409, 'health file is too large to edit safely');
        throw e;
      }

      const payloadHash = await sha256Hex(body);
      const operationId = `health-ingest:${payloadHash.slice(0, 32)}`;
      const executed = await executeWrite(store, { operationId, baseRevision: revision, payloadHash }, plan);
      if (executed.ok) return { ok: true, days, commitSha: executed.commitSha };
      return executeFailure(executed.message, executed.code);
    },
  };
}
