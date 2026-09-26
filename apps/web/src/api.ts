// Same-origin HTTP API (packages/contracts). `redirect: 'manual'` makes an expired Access session visible as an
// opaque redirect instead of silently following it to a login page (F11).
import {
  ActiveWorkResponse,
  encodeLinkedNoteHeader,
  LINKED_NOTE_HEADER,
  LinkedNoteResponse,
  SessionResponse,
  TasksResponse,
  type LinkedNoteRequest,
} from '@vault-companion/contracts';
import type { z } from 'zod';

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
    const parsed = schema.safeParse(body);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'error', message: 'Unexpected reply from the server.' };
  } finally {
    clearTimeout(timer);
  }
}

export const getSession = () => getJson('/api/session', SessionResponse);

export const getTasks = (known: readonly string[]) =>
  getJson(known.length ? `/api/tasks?known=${known.join(',')}` : '/api/tasks', TasksResponse);

/**
 * Linked note: the server resolves the note from the task locator; the request rides in a header so task text is never part
 * of a URL. `no-store` (base) and the service worker's `/api/*` bypass keep note text out of every cache.
 */
export const getLinkedNote = (req: LinkedNoteRequest) =>
  getJson('/api/linked-note', LinkedNoteResponse, { [LINKED_NOTE_HEADER]: encodeLinkedNoteHeader(req) });

/** Active Work Now card: fixed server-side path, `no-store`, never cached by the SW. */
export const getActiveWork = () => getJson('/api/active-work', ActiveWorkResponse);

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
