// Allowlisted structured logging (docs/security.md#logging). The record type is the allowlist:
// there is no field that can carry task text, note text, bodies, tokens or clear-text paths.
import { ErrorCode } from '@vault-companion/contracts';

export interface LogRecord {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly commandType?: string;
  readonly operationId?: string;
  readonly errorCode?: string;
  /** sha256 hex prefix of a vault path (a note path contains its title). */
  readonly pathHash?: string;
  readonly commitSha?: string;
  /** Class name of an unexpected error (e.g. `StoreUnavailable`). */
  readonly errorClass?: string;
  /** The error's message, only when it is one of the adapters' fixed diagnostics (see `diagnosticDetail`). */
  readonly errorDetail?: string;
  /** Per-reader fixed codes (ApiError.code enum strings, or `threw`), keyed by reader name; never free text. */
  readonly unavailableCodes?: Readonly<Record<string, string>>;
}

export type LogSink = (record: LogRecord) => void;

const ALLOWED: ReadonlySet<string> = new Set([
  'requestId', 'method', 'route', 'status', 'durationMs', 'commandType', 'operationId', 'errorCode', 'pathHash', 'commitSha',
  'errorClass', 'errorDetail', 'unavailableCodes',
]);

/** The Morning Brief reader names whose failure code may be logged (see morning-brief-gather.ts). */
const UNAVAILABLE_READER_NAMES: ReadonlySet<string> = new Set([
  'tasks', 'health', 'training', 'weather', 'mood', 'calendar', 'mail',
]);
/** Fixed failure reasons only: any `ApiError.code`, plus `threw` for an exception. */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([...ErrorCode.options, 'threw']);

/** Keeps only known reader names mapped to a fixed code; an unknown name or value is dropped, never logged. */
function sanitizeUnavailableCodes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, code] of Object.entries(value)) {
    if (UNAVAILABLE_READER_NAMES.has(name) && typeof code === 'string' && UNAVAILABLE_CODES.has(code)) clean[name] = code;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

/** Drops any key not in the allowlist even if a caller casts around the type. */
export function sanitize(record: LogRecord): LogRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!ALLOWED.has(k) || v === undefined) continue;
    if (k === 'unavailableCodes') {
      const codes = sanitizeUnavailableCodes(v);
      if (codes !== undefined) out[k] = codes;
      continue;
    }
    out[k] = v;
  }
  return out as unknown as LogRecord;
}

export async function hashPath(path: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Fixed diagnostic phrases of the GitHub adapter and token source: they carry at most an HTTP method or status, never
// vault text. Any other message is dropped, so an unexpected error cannot leak task or note text into the log.
const DIAGNOSTIC_PREFIXES = [
  'installation token request failed with status ', 'GitHub GET status ', 'GitHub POST ', 'GitHub ref update status ',
  'branch not found', 'base commit not found', 'commit tree not found', 'directory listing failed', 'network error ',
  'no parent', 'unsafe vault path rejected by adapter',
];

export function diagnosticDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  if (message.length > 100 || !/^[A-Za-z0-9 .:_-]+$/.test(message)) return undefined;
  return DIAGNOSTIC_PREFIXES.some((p) => message.startsWith(p)) ? message : undefined;
}
