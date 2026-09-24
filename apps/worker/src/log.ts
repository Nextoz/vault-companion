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
}

export type LogSink = (record: LogRecord) => void;

const ALLOWED: ReadonlySet<string> = new Set([
  'requestId', 'method', 'route', 'status', 'durationMs', 'commandType', 'operationId', 'errorCode', 'pathHash', 'commitSha',
]);

/** Drops any key not in the allowlist even if a caller casts around the type. */
export function sanitize(record: LogRecord): LogRecord {
  return Object.fromEntries(Object.entries(record).filter(([k, v]) => ALLOWED.has(k) && v !== undefined)) as unknown as LogRecord;
}

export async function hashPath(path: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
