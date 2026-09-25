// HTTP layer: authentication, request guards, validation and mapping to application services.
// No domain logic lives here (docs/architecture.md).
import {
  Command,
  decodeLinkedNoteHeader,
  LINKED_NOTE_HEADER,
  type ApiError,
  type ErrorCode,
  type LinkedNoteRequest,
  type LinkedNoteResponse,
  type Receipt,
  type TasksResponse,
} from '@vault-companion/contracts';
import { Hono } from 'hono';
import type { Identity } from './auth.ts';
import { hashPath, sanitize, type LogSink } from './log.ts';

export interface Services {
  readTasks(known: readonly string[]): Promise<TasksResponse | ApiError>;
  /** `command` is schema-valid; `raw` is the exact parsed body used for the payload hash. */
  execute(command: Command, raw: unknown): Promise<Receipt | ApiError>;
  /** Read-only linked note (P4-A). Optional: without it the route answers 404. */
  readLinkedNote?(req: LinkedNoteRequest): Promise<LinkedNoteResponse | ApiError>;
}

export interface AppDeps {
  readonly verify: (token: string | undefined) => Promise<Identity>;
  readonly appOrigin: string;
  readonly services: Services;
  readonly log: LogSink;
  readonly newRequestId?: () => string;
}

const MAX_BODY_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;

export function statusFor(code: ErrorCode): number {
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden') return 403;
  if (code === 'invalid' || code === 'clock-skew' || code === 'refused:path') return 400;
  if (code === 'upstream-unavailable') return 503;
  if (code.startsWith('refused:')) return 422;
  return 409; // conflict:*, operation-id-reused, dedupe-unknown
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const isApiError = (x: Receipt | ApiError | TasksResponse | LinkedNoteResponse): x is ApiError => 'code' in x && 'retryable' in x;

type Vars = { identity: Extract<Identity, { ok: true }>; logMeta: Record<string, string> };

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const err = (code: ErrorCode, message: string, retryable = false): ApiError => ({ code, message, retryable });

  app.use('*', async (c, next) => {
    const started = Date.now();
    c.set('logMeta', {});
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    const meta = c.get('logMeta');
    deps.log(
      sanitize({
        requestId: deps.newRequestId?.() ?? crypto.randomUUID(),
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Date.now() - started,
        ...meta,
      }),
    );
  });

  app.use('/api/*', async (c, next) => {
    const identity = await deps.verify(c.req.header('Cf-Access-Jwt-Assertion'));
    if (!identity.ok) return c.json(err('unauthorized', 'sign in required'), 401);
    c.set('identity', identity);
    await next();
  });

  app.get('/api/session', (c) => c.json({ accountKey: c.get('identity').accountKey }));

  app.get('/api/tasks', async (c) => {
    const known = (c.req.query('known') ?? '').split(',').filter((s) => SHA.test(s)).slice(0, 50);
    const result = await deps.services.readTasks(known);
    if (isApiError(result)) {
      c.get('logMeta').errorCode = result.code;
      return c.json(result, statusFor(result.code) as 400);
    }
    return c.json(result);
  });

  // P4-A: the request (task locator + link index) travels base64url in a header, never in the URL, so task text stays out
  // of URLs and access logs; a client path is not part of the contract. Logs carry neither note text nor its path.
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

  app.notFound((c) => c.json(err('invalid', 'not found'), 404));
  app.onError((_e, c) => c.json(err('upstream-unavailable', 'internal error', true), 503)); // commands.md: 503 (R11)
  return app;
}
