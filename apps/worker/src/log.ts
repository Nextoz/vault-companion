// Allowlisted structured logging (docs/security.md#logging). The record type is the allowlist:
// there is no field that can carry task text, note text, bodies, tokens or clear-text paths.

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
}

export type LogSink = (record: LogRecord) => void;

const ALLOWED: ReadonlySet<string> = new Set([
  'requestId', 'method', 'route', 'status', 'durationMs', 'commandType', 'operationId', 'errorCode', 'pathHash', 'commitSha',
  'errorClass', 'errorDetail',
]);

/** Drops any key not in the allowlist even if a caller casts around the type. */
export function sanitize(record: LogRecord): LogRecord {
  return Object.fromEntries(Object.entries(record).filter(([k, v]) => ALLOWED.has(k) && v !== undefined)) as unknown as LogRecord;
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
