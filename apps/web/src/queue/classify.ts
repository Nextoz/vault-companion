// Maps one POST /api/commands response to what the queue must do next (commands.md, brief F).
import { ApiError, Receipt } from '@vault-companion/contracts';
import type { PendingError } from './db.ts';

export type Outcome =
  | { kind: 'receipt'; receipt: Receipt }
  /** Terminal for automatic retry: the item waits for the user (Retry / Export / Discard). */
  | { kind: 'attention'; error: PendingError }
  | { kind: 'retry'; error: PendingError }
  /** Session expired: keep the item, pause the queue (F11). */
  | { kind: 'signed-out' };

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** `operationId` is the one that was sent: a receipt naming any other operation is not its receipt (R12). */
export async function classify(res: Response, operationId: string): Promise<Outcome> {
  // redirect: 'manual' turns an Access login redirect into an opaque redirect.
  if (res.type === 'opaqueredirect' || res.status === 401) return { kind: 'signed-out' };

  const body = await json(res);

  if (res.ok) {
    const receipt = Receipt.safeParse(body);
    // A malformed or misrouted 200 is retried: resending the identical envelope is deduplicated server-side.
    if (!receipt.success || receipt.data.operationId !== operationId) {
      return { kind: 'retry', error: { code: 'invalid-response', message: 'The server sent an unexpected reply.' } };
    }
    return { kind: 'receipt', receipt: receipt.data };
  }

  const error = ApiError.safeParse(body);
  if (!error.success) {
    // A 403 that is not our API's JSON is Cloudflare Access refusing the session.
    if (res.status === 403) return { kind: 'signed-out' };
    const e = { code: `http-${res.status}`, message: `The server answered ${res.status}.` };
    return res.status >= 500 || res.status === 408 || res.status === 429
      ? { kind: 'retry', error: e }
      : { kind: 'attention', error: e };
  }

  const { code, message, retryable } = error.data;
  if (code === 'unauthorized') return { kind: 'signed-out' };
  // Sent under an identity other than the item's (A7): final for automatic sending, whatever the flag says.
  if (code === 'account-mismatch') return { kind: 'attention', error: { code, message } };
  return retryable ? { kind: 'retry', error: { code, message } } : { kind: 'attention', error: { code, message } };
}

/**
 * Refusals known not to have applied (R4). Only these release an item's dependents and same-task successors;
 * `dedupe-unknown`, unparseable 4xx, `forbidden` and the like may hide an applied effect and keep them waiting.
 */
export function knownNotApplied(error: PendingError | null): boolean {
  if (error === null) return false;
  const { code } = error;
  return (
    code.startsWith('refused:') ||
    code.startsWith('conflict:') ||
    code === 'operation-id-reused' ||
    code === 'invalid' ||
    code === 'account-mismatch'
  );
}

/** 1 s → 60 s exponential backoff after `attempts` consecutive failures. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}
