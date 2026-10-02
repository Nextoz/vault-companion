// HTTP layer: authentication, request guards, validation and mapping to application services.
// No domain logic lives here (docs/architecture.md).
import {
  Command,
  DashboardRange,
  decodeLinkedNoteHeader,
  decodeNoteHeader,
  LINKED_NOTE_HEADER,
  NOTE_HEADER,
  MAX_KNOWN,
  RADAR_PAPER_HEADER,
  RadarPaperId,
  ResearchRadarDecideCommand,
  ScoutStatus,
  WeatherLocationRequest,
  type MarketTickerResponse,
  type MorningResponse,
  type ScoutsResponse,
  type ActiveWorkResponse,
  type TrainingResponse,
  type ApiError,
  type DashboardResponse,
  type ErrorCode,
  type HistoryResponse,
  type HealthResponse,
  type LinkedNoteRequest,
  type LinkedNoteResponse,
  type NoteReadResponse,
  type NotesResponse,
  type Receipt,
  type RadarNoteResponse,
  type RadarResponse,
  type ResearchRadarDecideCommand as ResearchRadarDecideCommandType,
  type TasksResponse,
  type TriageResponse,
  type WeatherResponse,
} from '@vault-companion/contracts';
import { Hono } from 'hono';
import type { Identity, ServiceTokenIdentity } from './auth.ts';
import { diagnosticDetail, hashPath, sanitize, type LogSink } from './log.ts';
import type { HealthIngestOutcome } from '@vault-companion/domain';

export interface Services {
  readTasks(known: readonly string[]): Promise<TasksResponse | ApiError>;
  /** `command` is schema-valid; `raw` is the exact parsed body used for the payload hash. */
  execute(command: Command, raw: unknown): Promise<Receipt | ApiError>;
  /** Research Radar decision writer (ADR-0032). Optional: without it the route answers 404. */
  executeRadarDecide?(command: ResearchRadarDecideCommandType, raw: unknown): Promise<Receipt | ApiError>;
  /** Read-only linked note (P4-A). Optional: without it the route answers 404. */
  readLinkedNote?(req: LinkedNoteRequest): Promise<LinkedNoteResponse | ApiError>;
  /** Active Work Now card. Optional: without it the route answers 404. */
  readTraining?(): Promise<TrainingResponse | ApiError>;
  readActiveWork?(): Promise<ActiveWorkResponse | ApiError>;
  readTriage?(): Promise<TriageResponse | ApiError>;
  readScouts?(): Promise<ScoutsResponse | ApiError>;
  /** "This morning" (ADR-0029 Part 2). Optional: without it the route answers 404. */
  readMorning?(): Promise<MorningResponse | ApiError>;
  /** Completion history (ADR-0021). Optional: without it the route answers 404. */
  readHistory?(): Promise<HistoryResponse | ApiError>;
  readScoutOutput?(scoutId: string): Promise<LinkedNoteResponse | ApiError>;
  /** Inbox notes (ADR-0022). Optional: without them the routes answer 404. */
  listNotes?(): Promise<NotesResponse | ApiError>;
  readNote?(path: string): Promise<NoteReadResponse | ApiError>;
  /** Dashboard (DASH1). Optional: without them the routes answer 404. */
  readDashboard?(range: DashboardRange): Promise<DashboardResponse | ApiError>;
  readMarketTicker?(): Promise<MarketTickerResponse | ApiError>;
  /** Research Radar (ADR-0032). Optional: without it the route answers 404. */
  readResearchRadar?(): Promise<RadarResponse | ApiError>;
  /** Server-side Radar note read (ADR-0032). The client sends a paper ID, never a path. */
  readRadarNote?(paperId: string): Promise<RadarNoteResponse | ApiError>;
  /** Weather projection (ADR-0033 W1). Optional: without it the routes answer 404. */
  readWeather?(): Promise<WeatherResponse | ApiError>;
  readWeatherAtLocation?(request: WeatherLocationRequest): Promise<WeatherResponse | ApiError>;
  /** Health daily card (HC1). Read-only. Optional: without it the route answers 404. */
  readHealth?(): Promise<HealthResponse | ApiError>;
  /** Health sample ingest (HC3a). Optional: without it the route answers 404. */
  ingestHealth?(body: string): Promise<HealthIngestOutcome>;
}

export interface AppDeps {
  readonly verify: (token: string | undefined) => Promise<Identity>;
  /** Scoped service-token verifier for POST /api/health/ingest. Optional: without it the route answers 404. */
  readonly verifyIngest?: ((token: string | undefined) => Promise<ServiceTokenIdentity>) | undefined;
  readonly appOrigin: string;
  readonly services: Services;
  readonly log: LogSink;
  readonly newRequestId?: () => string;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_HEALTH_INGEST_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export function statusFor(code: ErrorCode): number {
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden') return 403;
  if (code === 'invalid' || code === 'clock-skew' || code === 'refused:path') return 400;
  if (code === 'upstream-unavailable') return 503;
  if (code.startsWith('refused:')) return 422;
  return 409; // conflict:*, operation-id-reused, dedupe-unknown
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const isApiError = (x: Receipt | ApiError | TasksResponse | LinkedNoteResponse | ActiveWorkResponse | TrainingResponse | ScoutsResponse | HistoryResponse | NotesResponse | NoteReadResponse | TriageResponse | MorningResponse | DashboardResponse | MarketTickerResponse | RadarResponse | RadarNoteResponse | WeatherResponse | HealthResponse): x is ApiError => 'code' in x && 'retryable' in x;

type Vars = { identity: Extract<Identity, { ok: true }>; logMeta: Record<string, string> };

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const err = (code: ErrorCode, message: string, retryable = false): ApiError => ({ code, message, retryable });

  app.use('*', async (c, next) => {
    const started = Date.now();
    c.set('logMeta', {});
    await next();
    const durationMs = Date.now() - started;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    // SP step 1 (measure): the phone subtracts this from its own read time to see Access + network overhead.
    c.header('Server-Timing', `app;dur=${durationMs}`);
    const meta = c.get('logMeta');
    deps.log(
      sanitize({
        requestId: deps.newRequestId?.() ?? crypto.randomUUID(),
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs,
        ...meta,
      }),
    );
  });

  app.use('/api/*', async (c, next) => {
    // The ingest route has its own scoped service-token verifier; only that exact POST skips user auth.
    if (c.req.method === 'POST' && c.req.path === '/api/health/ingest') {
      await next();
      return;
    }
    const identity = await deps.verify(c.req.header('Cf-Access-Jwt-Assertion'));
    if (!identity.ok) return c.json(err('unauthorized', 'sign in required'), 401);
    c.set('identity', identity);
    await next();
  });

  app.get('/api/session', (c) => c.json({ accountKey: c.get('identity').accountKey }));

  app.get('/api/tasks', async (c) => {
    // Review O1: the same bound the client asks within; the rest are left unanswered (the client keeps overlaying them).
    const known = (c.req.query('known') ?? '').split(',').filter((s) => SHA.test(s)).slice(0, MAX_KNOWN);
    const result = await deps.services.readTasks(known);
    if (isApiError(result)) {
      c.get('logMeta').errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // Read-only linked note. The request (task locator + link index) travels base64url in a header, never in the URL, so
  // task text stays out of URLs and access logs; there is no client path. Logs carry neither note text nor its path.
  app.get('/api/linked-note', async (c) => {
    const read = deps.services.readLinkedNote;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const req = decodeLinkedNoteHeader(c.req.header(LINKED_NOTE_HEADER));
    if (!req) return c.json(err('invalid', 'invalid linked-note request'), 400);
    const meta = c.get('logMeta');
    const result = await read(req);
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `linked-note:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  // Active Work Now: a fixed read-only path, no request input. Logs carry neither its text nor its path.
  app.get('/api/active-work', async (c) => {
    const read = deps.services.readActiveWork;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const meta = c.get('logMeta');
    const result = await read();
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `active-work:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.get('/api/training', async (c) => {
    const read = deps.services.readTraining;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const meta = c.get('logMeta');
    const result = await read();
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `training:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.get('/api/radar', async (c) => {
    const read = deps.services.readResearchRadar;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    if (isApiError(result)) {
      c.get('logMeta').errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    c.get('logMeta').commitSha = result.revision;
    return c.json(result);
  });

  // Radar note read: the paper ID rides in a header, never in the URL; the service resolves it server-side from the
  // allowlisted research folders at a pinned revision. No note text or path is logged.
  app.get('/api/radar/read', async (c) => {
    const read = deps.services.readRadarNote;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const paperId = RadarPaperId.safeParse(c.req.header(RADAR_PAPER_HEADER));
    if (!paperId.success) return c.json(err('invalid', 'invalid paper ID'), 400);
    const result = await read(paperId.data);
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `radar-note:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.get('/api/triage', async (c) => {
    const read = deps.services.readTriage;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    if (isApiError(result)) {
      c.get('logMeta').errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    c.get('logMeta').commitSha = result.revision;
    return c.json(result);
  });

  // Completion history (ADR-0021): read-only, no request input. Logs carry no task text.
  app.get('/api/history', async (c) => {
    const read = deps.services.readHistory;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    meta.commitSha = result.revision;
    return c.json(result);
  });

  // "This morning": fixed read-only paths, no request input. Logs carry neither note text nor paths.
  app.get('/api/morning', async (c) => {
    const read = deps.services.readMorning;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.get('/api/scouts', async (c) => {
    const read = deps.services.readScouts;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    meta.commitSha = result.revision;
    return c.json(result);
  });

  // Health daily card (HC1): ONE fixed vault file, read-only. The path is a constant, never accepted from the client;
  // logs carry only the commit SHA (no health value, row or file text).
  app.get('/api/health', async (c) => {
    const read = deps.services.readHealth;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    meta.commitSha = result.revision;
    return c.json(result);
  });

  // Health sample ingest (HC3a): scoped service-token auth, no origin/account CSRF guards (a Shortcut calls it
  // directly). The domain service validates everything else; no health value, line or row is ever logged here.
  app.post('/api/health/ingest', async (c) => {
    const ingest = deps.services.ingestHealth;
    const verifyIngest = deps.verifyIngest;
    if (!ingest || !verifyIngest) return c.json({ ok: false, error: 'not found' }, 404);
    const identity = await verifyIngest(c.req.header('Cf-Access-Jwt-Assertion'));
    if (!identity.ok) {
      c.get('logMeta').errorCode = `health-ingest:auth:${identity.reason}`;
      return c.json({ ok: false, error: 'sign in required' }, 401);
    }

    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_HEALTH_INGEST_BYTES) {
      return c.json({ ok: false, error: 'body too large' }, 413);
    }
    const result = await ingest(text);
    const meta = c.get('logMeta');
    if (!result.ok) {
      meta.errorCode = `health-ingest:${result.status}`;
      return c.json({ ok: false, error: result.error }, result.status as 400);
    }
    meta.commitSha = result.commitSha;
    return c.json({ ok: true, days: [...result.days] });
  });

  // Inbox notes (ADR-0022). Logs carry neither note text, titles nor paths.
  app.get('/api/notes', async (c) => {
    const read = deps.services.listNotes;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    meta.commitSha = result.revision;
    return c.json(result);
  });

  // The note path travels in a header (percent-encoded), never in the URL; the service accepts it only if listed.
  app.get('/api/notes/read', async (c) => {
    const read = deps.services.readNote;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const path = decodeNoteHeader(c.req.header(NOTE_HEADER));
    if (path === null) return c.json(err('invalid', 'invalid note path'), 400);
    const result = await read(path);
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `note:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.get('/api/scouts/output', async (c) => {
    const read = deps.services.readScoutOutput;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const id = ScoutStatus.shape.scoutId.safeParse(c.req.header('X-VC-Scout'));
    if (!id.success) return c.json(err('invalid', 'invalid scout ID'), 400);
    const result = await read(id.data);
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    if (result.status === 'refused') meta.errorCode = `scout-output:${result.code}`;
    meta.commitSha = result.revision;
    return c.json(result);
  });

  app.post('/api/commands', async (c) => {
    // CSRF / origin (T4): JSON only, custom header, exact origin.
    if (c.req.header('Origin') !== deps.appOrigin || c.req.header('X-VC-Request') !== '1') {
      return c.json(err('forbidden', 'request origin not allowed'), 403);
    }
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(err('forbidden', 'JSON required'), 403);
    }
    // Review A7: the device says which account queued this command; it must be the one signed in now.
    if (c.req.header('X-VC-Account') !== c.get('identity').accountKey) {
      return c.json(err('account-mismatch', 'this action was saved under a different sign-in'), 409);
    }
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return c.json(err('invalid', 'body too large'), 400);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json(err('invalid', 'body is not JSON'), 400);
    }
    const parsed = Command.safeParse(raw);
    if (!parsed.success) {
      // Report field paths only; never echo submitted values.
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
      return c.json(err('invalid', `invalid command: ${fields}`), 400);
    }
    const meta = c.get('logMeta');
    meta.commandType = parsed.data.type;
    meta.operationId = parsed.data.operationId;
    const result = await deps.services.execute(parsed.data, raw);
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json({ ...result, operationId: parsed.data.operationId }, statusFor(result.code) as 400);
    }
    meta.pathHash = await hashPath(result.path);
    meta.commitSha = result.commitSha;
    return c.json(result);
  });

  // Dashboard (DASH1): read-only, authenticated. The range is an enum, the provider URL is built worker-side only.
  app.get('/api/dashboard', async (c) => {
    const read = deps.services.readDashboard;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const range = DashboardRange.safeParse(c.req.query('range') ?? '1W');
    if (!range.success) return c.json(err('invalid', 'invalid range'), 400);
    const result = await read(range.data);
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // The 60-second refresh reads only the current value: the historical series is never polled every minute.
  app.get('/api/dashboard/ticker', async (c) => {
    const read = deps.services.readMarketTicker;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // Weather projection (ADR-0033 W1): read-only default GET uses the fixed coarse Copenhagen fallback. No model/URL
  // input is accepted; the provider URL is built worker-side from the contract allowlist.
  app.get('/api/weather', async (c) => {
    const read = deps.services.readWeather;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const result = await read();
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // Precise device location rides a same-origin authenticated JSON POST so raw coordinates stay out of URL query logs.
  // The same origin/account guards as commands apply; the service rounds the values before any provider call/cache key.
  app.post('/api/weather/location', async (c) => {
    if (c.req.header('Origin') !== deps.appOrigin || c.req.header('X-VC-Request') !== '1') {
      return c.json(err('forbidden', 'request origin not allowed'), 403);
    }
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(err('forbidden', 'JSON required'), 403);
    }
    if (c.req.header('X-VC-Account') !== c.get('identity').accountKey) {
      return c.json(err('account-mismatch', 'this action was saved under a different sign-in'), 409);
    }
    const read = deps.services.readWeatherAtLocation;
    if (!read) return c.json(err('invalid', 'not found'), 404);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return c.json(err('invalid', 'body too large'), 400);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json(err('invalid', 'body is not JSON'), 400);
    }
    const location = WeatherLocationRequest.safeParse(raw);
    if (!location.success) return c.json(err('invalid', 'invalid device location'), 400);
    const result = await read(location.data);
    const meta = c.get('logMeta');
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // Radar decisions ride their own command type and endpoint; the write uses the same origin/account/body guards.
  app.post('/api/radar/decisions', async (c) => {
    if (c.req.header('Origin') !== deps.appOrigin || c.req.header('X-VC-Request') !== '1') {
      return c.json(err('forbidden', 'request origin not allowed'), 403);
    }
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(err('forbidden', 'JSON required'), 403);
    }
    if (c.req.header('X-VC-Account') !== c.get('identity').accountKey) {
      return c.json(err('account-mismatch', 'this action was saved under a different sign-in'), 409);
    }
    const decide = deps.services.executeRadarDecide;
    if (!decide) return c.json(err('invalid', 'not found'), 404);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return c.json(err('invalid', 'body too large'), 400);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json(err('invalid', 'body is not JSON'), 400);
    }
    const parsed = ResearchRadarDecideCommand.safeParse(raw);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
      return c.json(err('invalid', `invalid command: ${fields}`), 400);
    }
    const meta = c.get('logMeta');
    meta.commandType = parsed.data.type;
    meta.operationId = parsed.data.operationId;
    const result = await decide(parsed.data, raw);
    if (isApiError(result)) {
      meta.errorCode = result.code;
      return c.json({ ...result, operationId: parsed.data.operationId }, statusFor(result.code) as 400);
    }
    meta.pathHash = await hashPath(result.path);
    meta.commitSha = result.commitSha;
    return c.json(result);
  });

  app.notFound((c) => c.json(err('invalid', 'not found'), 404));
  app.onError((e, c) => {
    const meta = c.get('logMeta');
    if (meta) {
      meta.errorClass = e instanceof Error ? e.name : 'unknown';
      const detail = diagnosticDetail(e);
      if (detail) meta.errorDetail = detail;
    }
    return c.json(err('upstream-unavailable', 'internal error', true), 503); // commands.md: 503 (R11)
  });
  return app;
}
