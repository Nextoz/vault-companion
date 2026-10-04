// Same-origin HTTP API (packages/contracts). `redirect: 'manual'` makes an expired Access session visible as an
// opaque redirect instead of silently following it to a login page (F11).
import {
  ActiveWorkResponse,
  AiBudgetResponse,
  AiUsageResponse,
  DashboardResponse,
  MarketTickerResponse,
  TrainingResponse,
  LearningResponse,
  encodeLinkedNoteHeader,
  encodeNoteHeader,
  HistoryResponse,
  HealthHistoryResponse,
  HealthResponse,
  LINKED_NOTE_HEADER,
  LinkedNoteResponse,
  NOTE_HEADER,
  NoteReadResponse,
  NotesResponse,
  RADAR_PAPER_HEADER,
  RadarNoteResponse,
  RadarResponse,
  SessionResponse,
  MorningBriefResponse,
  MorningBriefReadResponse,
  MorningResponse,
  ScoutsResponse,
  TasksResponse,
  TriageResponse,
  WeatherResponse,
  type DashboardRange,
  type LinkedNoteRequest,
  type WeatherLocationRequest,
} from '@vault-companion/contracts';
import { z } from 'zod';
import { recordRead } from './timings.ts';

export type Fetched<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string };

/** A command request the server has not answered by then is aborted and retried (N5). Below the queue's lease. */
export const COMMAND_TIMEOUT_MS = 30_000;

/** A session or task read the server has not fully answered by then is abandoned as an error (P4-B). */
export const READ_TIMEOUT_MS = 10_000;

const base: RequestInit = { redirect: 'manual', credentials: 'same-origin', cache: 'no-store' };

const TIMED_OUT = 'The server did not answer in time.';

export async function getJson<S extends z.ZodType>(url: string, schema: S, headers: Record<string, string> = {}): Promise<Fetched<z.infer<S>>> {
  // A timer rather than AbortSignal.timeout: it bounds the body as well as the headers, and tests can drive it.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
  const started = performance.now();
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...base, signal: abort.signal, headers: { Accept: 'application/json', ...headers } });
    } catch {
      return abort.signal.aborted ? { kind: 'error', message: TIMED_OUT } : { kind: 'offline' };
    }
    if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return { kind: 'signed-out' };
    if (!res.ok) return { kind: 'error', message: `The server answered ${res.status}.` };
    // Fetch aborts the body with the signal; the race also bounds a body that ignores it.
    const aborted = new Promise<undefined>((resolve) => abort.signal.addEventListener('abort', () => resolve(undefined)));
    const body: unknown = await Promise.race([res.json().catch(() => undefined), aborted]);
    if (abort.signal.aborted) return { kind: 'error', message: TIMED_OUT };
    recordRead(url, performance.now() - started, res.headers.get('Server-Timing'));
    const parsed = schema.safeParse(body);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: 'Unexpected reply from the server.' };
  } finally {
    clearTimeout(timer);
  }
}

export const getSession = () => getJson('/api/session', SessionResponse);
export const getScouts = () => getJson('/api/scouts', ScoutsResponse.strip());
export const getMorning = () => getJson('/api/morning', MorningResponse.strip());
export const getMorningBrief = () => getJson('/api/morning-brief', z.union(MorningBriefReadResponse.options.map((option) => option.strip())));
export const getAiBudget = () => getJson('/api/ai-budget', AiBudgetResponse.strip());
export const getAiUsage = () => getJson('/api/ai-usage', AiUsageResponse.strip());
export const getTriage = () => getJson('/api/triage', TriageResponse.strip());
export const getRadar = () => getJson('/api/radar', RadarResponse.strip());
export const getRadarNote = (paperId: string) =>
  getJson('/api/radar/read', RadarNoteResponse, { [RADAR_PAPER_HEADER]: paperId });
export const getScoutOutput = (id: string) => getJson('/api/scouts/output', LinkedNoteResponse, { 'X-VC-Scout': id });

// .strip(): a new top-level field from a newer server is ignored, not an error. A PWA resumed from the background keeps
// running the previous build while the Worker already serves the next one.
export const getTasks = (known: readonly string[]) =>
  getJson(known.length ? `/api/tasks?known=${known.join(',')}` : '/api/tasks', TasksResponse.strip());

/**
 * Linked note: the server resolves the note from the task locator; the request rides in a header so task text is never part
 * of a URL. `no-store` (base) and the service worker's `/api/*` bypass keep note text out of every cache.
 */
export const getLinkedNote = (req: LinkedNoteRequest) =>
  getJson('/api/linked-note', LinkedNoteResponse, { [LINKED_NOTE_HEADER]: encodeLinkedNoteHeader(req) });

/** Active Work Now card: fixed server-side path, `no-store`, never cached by the SW. */
export const getActiveWork = () => getJson('/api/active-work', z.union(ActiveWorkResponse.options.map((option) => option.strip())));

/** Completion history (ADR-0021): read-only, `no-store`, never cached by the SW. */
export const getHistory = () => getJson('/api/history', HistoryResponse.strip());

/** Inbox notes (ADR-0022): `no-store`, never cached by the SW. The path rides in a header, never in the URL. */
export const getNotes = () => getJson('/api/notes', NotesResponse.strip());
export const getNote = (path: string) =>
  getJson('/api/notes/read', z.union(NoteReadResponse.options.map((option) => option.strip())), { [NOTE_HEADER]: encodeNoteHeader(path) });

/** `accountKey` is the queued item's binding, checked by the Worker against the session (A7), outside the body. */
export const postCommand = (body: string, accountKey: string) =>
  fetch('/api/commands', {
    ...base,
    method: 'POST',
    body,
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-VC-Request': '1',
      'X-VC-Account': accountKey,
      Accept: 'application/json',
    },
  });

/** Radar decisions use their own wire endpoint but the same CSRF/account/session guards as `/api/commands`. */
export const postRadarDecision = (body: string, accountKey: string) =>
  fetch('/api/radar/decisions', {
    ...base,
    method: 'POST',
    body,
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-VC-Request': '1',
      'X-VC-Account': accountKey,
      Accept: 'application/json',
    },
  });

export const getTraining = () => getJson('/api/training', z.union(TrainingResponse.options.map((option) => option.strip())));
export const getLearning = () => getJson('/api/learning', z.union(LearningResponse.options.map((option) => option.strip())));

/** Dashboard (DASH1): read-only, `no-store`, never cached by the SW. The range is an enum, never a provider URL. */
export const getDashboard = (range: DashboardRange) => getJson(`/api/dashboard?range=${range}`, DashboardResponse);

/** The 60-second refresh: the current value only. The historical series is not polled per minute. */
export const getMarketTicker = () => getJson('/api/dashboard/ticker', MarketTickerResponse);

/** Weather projection (ADR-0033 W1): default read is the fixed coarse Copenhagen fallback. */
export const getWeather = () => getJson('/api/weather', WeatherResponse);

/** Health daily card (HC1/HC2): read-only projection of the one fixed Apple Health export. */
export const getHealth = () => getJson('/api/health', HealthResponse);

/** Health history view (HC3b): the same fixed export, other than the card's shown day and baseline. */
export const getHealthHistory = () => getJson('/api/health/history', HealthHistoryResponse);

/** Precise device location only after explicit foreground consent, sent as a bounded same-origin JSON POST. */
export async function postWeatherLocation(location: WeatherLocationRequest, accountKey: string): Promise<Fetched<WeatherResponse>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), READ_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch('/api/weather/location', {
        ...base,
        method: 'POST',
        signal: abort.signal,
        body: JSON.stringify(location),
        headers: {
          'Content-Type': 'application/json',
          'X-VC-Request': '1',
          'X-VC-Account': accountKey,
          Accept: 'application/json',
        },
      });
    } catch {
      return abort.signal.aborted ? { kind: 'error', message: TIMED_OUT } : { kind: 'offline' };
    }
    if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return { kind: 'signed-out' };
    if (!res.ok) return { kind: 'error', message: `The server answered ${res.status}.` };
    const aborted = new Promise<undefined>((resolve) => abort.signal.addEventListener('abort', () => resolve(undefined)));
    const body: unknown = await Promise.race([res.json().catch(() => undefined), aborted]);
    if (abort.signal.aborted) return { kind: 'error', message: TIMED_OUT };
    const parsed = WeatherResponse.safeParse(body);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: 'Unexpected reply from the server.' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Calendar writes (CAL-b, ADR-0048/0052) ----

/**
 * `GET /api/calendar/links`: the item keys already linked to a Google event. The schema is repeated here rather than
 * imported from @vault-companion/domain, which apps/web does not depend on; the Worker re-validates its own reads.
 */
const CalendarLinksRead = z.strictObject({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  links: z.record(z.string(), z.string()),
});
export type CalendarLinks = z.infer<typeof CalendarLinksRead>;

export const getCalendarLinks = () => getJson('/api/calendar/links', CalendarLinksRead);

/** The create body validated by the Worker's `CalendarEventCreateRequest` (date xor start/end). */
export interface CalendarEventInput {
  operationId: string;
  itemKey: string;
  title: string;
  date?: string;
  start?: string;
  end?: string;
  type: string;
  notes?: string;
}

export interface CalendarEventRemoval {
  operationId: string;
  itemKey: string;
}

export type CalendarWriteResult =
  | { kind: 'ok' }
  | { kind: 'offline' }
  | { kind: 'signed-out' }
  | { kind: 'error'; code: string | null };

/**
 * Both calendar writes are direct (no offline queue): a failed write is surfaced inline, never replayed later. The
 * caller keeps one `operationId` per sheet open, so the Worker's Google dedupe makes a repeated send one event.
 */
async function postCalendar(url: string, body: unknown, accountKey: string): Promise<CalendarWriteResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...base,
      method: 'POST',
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        'X-VC-Request': '1',
        'X-VC-Account': accountKey,
        Accept: 'application/json',
      },
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.type === 'opaqueredirect' || res.status === 401) return { kind: 'signed-out' };
  if (!res.ok) {
    const parsed = z.object({ code: z.string() }).safeParse(await res.json().catch(() => undefined));
    return { kind: 'error', code: parsed.success ? parsed.data.code : null };
  }
  return { kind: 'ok' };
}

export const createCalendarEvent = (event: CalendarEventInput, accountKey: string) =>
  postCalendar('/api/calendar/events', event, accountKey);

export const removeCalendarEvent = (removal: CalendarEventRemoval, accountKey: string) =>
  postCalendar('/api/calendar/events/remove', removal, accountKey);
