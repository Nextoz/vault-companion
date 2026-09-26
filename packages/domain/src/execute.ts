// Write executor: docs/commands.md "Execution algorithm". Generic over a per-command plan so the
// retry/dedupe/CAS logic is independent of what the mutation does.
import type { ErrorCode } from '@vault-companion/contracts';
import { StoreUnavailable, StoreUnknownOutcome, TRAILER_OP, TRAILER_PAYLOAD, type FindOperationResult, type VaultPath, type VaultStore } from './store.ts';

/**
 * Head-moved re-plans per command (ADR-0015): three attempts keep every write command within Workers Free's 50
 * subrequests per invocation, including a cold installation token and the Access JWKS fetch.
 */
export const MAX_ATTEMPTS = 3;

/** Shown when one compare page cannot settle whether the operation already applied (ADR-0015). */
export const MAY_BE_APPLIED = 'this may already be applied — check Obsidian';

/** A computed change against the vault at one commit. */
export type Planned<E> =
  | { readonly ok: true; readonly path: VaultPath; readonly expect: 'absent' | 'regular-file'; readonly bytes: Uint8Array; readonly effect: E }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

export interface WritePlan<E> {
  /** Pure given the store's state at `atCommit`: read, mutate, return bytes or a refusal. */
  compute(store: VaultStore, atCommit: string): Promise<Planned<E>>;
  /**
   * Re-derive the effect of an already-applied commit (review F5). Default: replay `compute` on the
   * commit's parent and require byte-identical output at the same path.
   */
  deriveApplied?(store: VaultStore, commitSha: string, changedPaths: readonly string[]): Promise<Derived<E>>;
  /**
   * Replace the default dedupe (one listing of `baseRevision..X`, ADR-0015) with the plan's own bounded check at X,
   * which may also refuse (Undo, ADR-0013). Runs once per attempt, before `compute` at the same X.
   */
  findApplied?(store: VaultStore, atCommit: string, operationId: string): Promise<FindOperationResult | Refused>;
  /** Attempts (head-moved re-plans) for this plan; default `MAX_ATTEMPTS`. */
  readonly maxAttempts?: number;
  /** Commit subject; must not contain personal text. */
  readonly message: string;
  /** Extra commit trailers (IDs only, never personal text). */
  readonly trailers?: Readonly<Record<string, string>>;
}

export type Refused = { readonly kind: 'refused'; readonly code: ErrorCode; readonly message: string };

export type Derived<E> = { readonly ok: true; readonly path: string; readonly effect: E } | { readonly ok: false; readonly reason: string };

export interface ExecuteInput {
  readonly operationId: string;
  readonly baseRevision: string;
  readonly payloadHash: string;
}

export type ExecuteResult<E> =
  | { readonly ok: true; readonly status: 'applied' | 'already-applied'; readonly path: string; readonly commitSha: string; readonly blobSha: string; readonly effect: E }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryable: boolean };

const fail = <E>(code: ErrorCode, message: string, retryable = false): ExecuteResult<E> => ({ ok: false, code, message, retryable });

/**
 * ADR-0015: dedupe over ONE single-page listing of `baseRevision..X` (≤ `COMPARE_PAGE` commits), never paged. A base
 * that is not an ancestor of X, or more than one page, cannot settle whether this operation already applied: typed
 * `dedupe-unknown`, never a guess. (The client keeps the window small by moving a never-sent item's base forward.)
 */
export async function findInOnePage(store: VaultStore, baseRevision: string, x: string, operationId: string): Promise<FindOperationResult | Refused> {
  const since = await store.commitsSince(baseRevision, x);
  if (since.kind !== 'ok') return { kind: 'refused', code: 'dedupe-unknown', message: MAY_BE_APPLIED };
  const own = since.commits.find((c) => c.trailers[TRAILER_OP] === operationId);
  if (!own) return { kind: 'not-found' };
  const info = await store.readCommit(own.sha);
  return { kind: 'found', op: { commitSha: own.sha, payloadHash: own.trailers[TRAILER_PAYLOAD] ?? '', paths: (info?.files ?? []).map((f) => f.path) } };
}

export async function replayOnParent<E>(plan: WritePlan<E>, store: VaultStore, commitSha: string, changedPaths: readonly string[]): Promise<Derived<E>> {
  const parent = await store.parentOf(commitSha);
  const replay = await plan.compute(store, parent);
  if (!replay.ok) return { ok: false, reason: `replay refused: ${replay.code}` };
  if (!changedPaths.includes(replay.path)) return { ok: false, reason: 'replay targets a different path' };
  const actual = await store.readFile(replay.path, commitSha);
  if (!actual || !bytesEqual(actual.bytes, replay.bytes)) return { ok: false, reason: 'replay differs from committed bytes' };
  return { ok: true, path: replay.path, effect: replay.effect };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function executeWrite<E>(store: VaultStore, input: ExecuteInput, plan: WritePlan<E>): Promise<ExecuteResult<E>> {
  let lastWasUnknown = false;
  try {
    for (let attempt = 1; attempt <= (plan.maxAttempts ?? MAX_ATTEMPTS); attempt++) {
      // One immutable commit X per attempt: dedupe window and reads both end at X (review F1).
      const { commitSha: x } = await store.head();

      const found = plan.findApplied
        ? await plan.findApplied(store, x, input.operationId)
        : await findInOnePage(store, input.baseRevision, x, input.operationId);
      if (found.kind === 'refused') return fail(found.code, found.message);
      if (found.kind === 'unknown') return fail('dedupe-unknown', `cannot establish whether the operation was applied (${found.reason})`);
      if (found.kind === 'found') {
        if (found.op.payloadHash !== input.payloadHash) return fail('operation-id-reused', 'operation ID was already used for a different payload');
        const derived = await (plan.deriveApplied ?? ((s, c, p) => replayOnParent(plan, s, c, p)))(store, found.op.commitSha, found.op.paths);
        if (!derived.ok) return fail('dedupe-unknown', `applied commit found but its effect cannot be verified (${derived.reason})`);
        const file = await store.readFile(derived.path as VaultPath, found.op.commitSha);
        return { ok: true, status: 'already-applied', path: derived.path, commitSha: found.op.commitSha, blobSha: file!.blobSha, effect: derived.effect };
      }

      const planned = await plan.compute(store, x);
      if (!planned.ok) return fail(planned.code, planned.message);

      let written;
      try {
        written = await store.writeFile({
          path: planned.path,
          baseCommit: x,
          expect: planned.expect,
          bytes: planned.bytes,
          message: plan.message,
          trailers: { ...plan.trailers, [TRAILER_OP]: input.operationId, [TRAILER_PAYLOAD]: input.payloadHash },
        });
      } catch (err) {
        // Unknown outcome: never re-send blindly; the next attempt's dedupe decides.
        if (err instanceof StoreUnknownOutcome) {
          lastWasUnknown = true;
          continue;
        }
        throw err;
      }
      if (!written.ok && written.reason === 'precondition-failed') {
        return fail('refused:structure', 'the target in the vault is not what this change expects; nothing was written');
      }
      if (written.ok) {
        return { ok: true, status: 'applied', path: planned.path, commitSha: written.commitSha, blobSha: written.blobSha, effect: planned.effect };
      }
      lastWasUnknown = false;
      // Head moved after X (possibly our own earlier attempt, or an Undo restoring identical bytes — review A2):
      // loop re-dedupes against a newer X.
    }
    if (lastWasUnknown) return fail('upstream-unavailable', 'GitHub did not confirm the write; it will be retried safely', true);
    return fail('conflict:stale', 'the vault kept changing; try again', true);
  } catch (err) {
    if (err instanceof StoreUnavailable || err instanceof StoreUnknownOutcome) {
      return fail('upstream-unavailable', 'GitHub is not reachable right now', true);
    }
    throw err;
  }
}
