// ADR-0055: the Morning Brief cron writes one shared ScoutStatus record after every run (skipped-by-guard excluded),
// including failed runs. The record carries fixed codes only: no brief text, note text, task text or keys.
import { ScoutStatus } from '@vault-companion/contracts';
import { canWrite, MORNING_BRIEF_STATUS_PATH, parseVaultPath } from './paths.ts';
import { commitCost, TRAILER_JOB } from './research-explainer.ts';
import { StoreUnknownOutcome, TRAILER_OP, type VaultStore } from './store.ts';

export const MORNING_BRIEF_SCOUT_ID = 'morning-brief';
export const MORNING_BRIEF_SCHEDULE = 'daily 06:31-08:31 Europe/Copenhagen';
export const MORNING_BRIEF_SOURCES = 7;
export const MORNING_BRIEF_STATUS_WRITE_ATTEMPTS = 2;
/** GitHub requests of one status-only commit, mirroring the explainer's commit-cost model. */
export const MORNING_BRIEF_STATUS_COMMIT_COST = commitCost(1);

export type MorningBriefOutcome = 'committed' | 'already-written' | 'not-written' | 'internal';

export interface MorningBriefStatusFacts {
  readonly nowIso: string;
  readonly operationId: string;
  readonly outcome: MorningBriefOutcome;
  readonly unavailable: readonly string[];
  readonly source: 'model' | 'fallback';
  /** Fixed error code, never free text. Null for a successful or deduped run. */
  readonly errorCode: string | null;
}

export interface MorningBriefStatusAt {
  readonly exists: boolean;
  readonly prev: ScoutStatus | null;
}

export async function readMorningBriefStatus(store: VaultStore, at: string): Promise<MorningBriefStatusAt> {
  const path = parseVaultPath(MORNING_BRIEF_STATUS_PATH);
  const file = path ? await store.readFile(path, at) : null;
  if (!file) return { exists: false, prev: null };
  try {
    const parsed = ScoutStatus.safeParse(JSON.parse(new TextDecoder().decode(file.bytes)));
    return { exists: true, prev: parsed.success ? parsed.data : null };
  } catch {
    return { exists: true, prev: null };
  }
}

export function buildMorningBriefStatus(prev: ScoutStatus | null, facts: MorningBriefStatusFacts): ScoutStatus {
  const failure = facts.outcome === 'not-written' || facts.outcome === 'internal';
  const success = facts.outcome === 'committed' || facts.outcome === 'already-written';
  const degraded = !failure && facts.outcome === 'committed' && (facts.unavailable.length > 0 || facts.source === 'fallback');
  const runStatus: ScoutStatus['runStatus'] & string = failure ? 'failed' : degraded ? 'degraded' : 'success';
  const successful = Math.max(0, MORNING_BRIEF_SOURCES - facts.unavailable.length);
  const lastError = facts.errorCode ?? (facts.unavailable.length > 0 ? `unavailable:${[...facts.unavailable].join(',')}` : null);
  return {
    schemaVersion: 1,
    scoutId: MORNING_BRIEF_SCOUT_ID,
    displayName: 'Morning Brief',
    schedule: MORNING_BRIEF_SCHEDULE,
    expectedEveryHours: 24,
    lastAttemptAt: facts.nowIso,
    lastSuccessAt: success ? facts.nowIso : (prev?.lastSuccessAt ?? null),
    runStatus,
    sources: { configured: MORNING_BRIEF_SOURCES, successful: success ? successful : 0 },
    aiHealth: failure ? 'failed' : facts.source === 'model' && facts.unavailable.length === 0 ? 'healthy' : 'degraded',
    findings: facts.outcome === 'committed' ? 1 : 0,
    added: facts.outcome === 'committed' ? 1 : 0,
    errors: failure ? 1 : facts.unavailable.length,
    lastError: lastError ? lastError.slice(0, 200) : null,
    latestOutput: prev?.latestOutput ?? null,
    history: [...(prev?.history ?? []), {
      at: facts.nowIso,
      status: runStatus,
      findings: facts.outcome === 'committed' ? 1 : 0,
      operationId: facts.operationId,
    }].slice(-30),
  };
}

export const morningBriefStatusBytes = (record: ScoutStatus): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);

export type MorningBriefStatusWriteResult =
  | { readonly kind: 'committed'; readonly commitSha: string; readonly operationId: string }
  | { readonly kind: 'not-written'; readonly reason: 'path-refused' | 'precondition-failed' | 'head-moved' | 'unknown-outcome'; readonly operationId: string };

/**
 * Best-effort status-only commit, parented on the current head. The caller logs a failure; this function never logs
 * text and never throws for a write refusal, but store outages still propagate to the caller's own try/catch.
 */
export async function writeMorningBriefStatus(args: { readonly store: VaultStore; readonly facts: MorningBriefStatusFacts }): Promise<MorningBriefStatusWriteResult> {
  const path = parseVaultPath(MORNING_BRIEF_STATUS_PATH);
  if (!path) return { kind: 'not-written', reason: 'path-refused', operationId: args.facts.operationId };
  let unknown = false;
  for (let attempt = 1; attempt <= MORNING_BRIEF_STATUS_WRITE_ATTEMPTS; attempt++) {
    const { commitSha: base } = await args.store.head();
    const at = await readMorningBriefStatus(args.store, base);
    const record = buildMorningBriefStatus(at.prev, args.facts);
    if (!canWrite(path, at.exists ? 'update' : 'create')) return { kind: 'not-written', reason: 'path-refused', operationId: args.facts.operationId };
    try {
      const res = await args.store.writeFiles({
        baseCommit: base,
        files: [{ path, expect: at.exists ? 'regular-file' : 'absent', bytes: morningBriefStatusBytes(record) }],
        message: 'Vault Companion: morning brief status',
        trailers: { [TRAILER_JOB]: MORNING_BRIEF_SCOUT_ID, [TRAILER_OP]: args.facts.operationId },
      });
      if (res.ok) return { kind: 'committed', commitSha: res.commitSha, operationId: args.facts.operationId };
      if (res.reason === 'precondition-failed') return { kind: 'not-written', reason: 'precondition-failed', operationId: args.facts.operationId };
      unknown = false;
    } catch (err) {
      if (!(err instanceof StoreUnknownOutcome)) throw err;
      unknown = true;
    }
  }
  return { kind: 'not-written', reason: unknown ? 'unknown-outcome' : 'head-moved', operationId: args.facts.operationId };
}
