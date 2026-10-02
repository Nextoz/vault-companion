// Morning Brief cron write (ADR-0046): at most one file in one commit, CAS on the existing blob SHA, and a
// deterministic operation ID so the second daily cron and retries never double-commit. Pure domain code.
import { parseBriefFile, serializeBriefFile, type BriefFile } from './morning-brief-file.ts';
import { MORNING_BRIEF_PATH, canWrite, parseVaultPath } from './paths.ts';
import { StoreUnknownOutcome, TRAILER_OP, type VaultStore } from './store.ts';
import { TRAILER_JOB, uuidV5 } from './research-explainer.ts';

export const MORNING_BRIEF_JOB_ID = 'morning-brief';
export const MORNING_BRIEF_WRITE_ATTEMPTS = 2;

/** `morning-brief:<date>`; same date ⇒ same operation ID. */
export const morningBriefOperationId = (date: string): Promise<string> => uuidV5(`morning-brief:${date}`);

export interface CommitMorningBriefArgs {
  readonly store: VaultStore;
  readonly operationId: string;
  readonly file: BriefFile;
}

export type MorningBriefWriteResult =
  | { readonly kind: 'committed'; readonly commitSha: string; readonly operationId: string }
  | { readonly kind: 'already-written'; readonly operationId: string }
  | {
      readonly kind: 'not-written';
      readonly reason: 'path-refused' | 'unreadable' | 'precondition-failed' | 'head-moved' | 'unknown-outcome';
    };

/**
 * Write `Daily/Morning Digest/Morning Brief - latest.json` once. If the existing file already has today's date, do
 * nothing. An unknown write outcome is re-checked at the new head: if the commit landed, the date read returns
 * `already-written`; otherwise the write is retried once.
 */
export async function commitMorningBrief(args: CommitMorningBriefArgs): Promise<MorningBriefWriteResult> {
  const path = parseVaultPath(MORNING_BRIEF_PATH);
  if (!path) return { kind: 'not-written', reason: 'path-refused' };
  let unknown = false;
  for (let attempt = 1; attempt <= MORNING_BRIEF_WRITE_ATTEMPTS; attempt++) {
    const { commitSha: base } = await args.store.head();
    const existing = await args.store.readFile(path, base);
    if (existing) {
      const current = parseBriefFile(existing.bytes);
      if (!current) return { kind: 'not-written', reason: 'unreadable' };
      if (current.date === args.file.date) return { kind: 'already-written', operationId: args.operationId };
    }
    if (!canWrite(path, existing ? 'update' : 'create')) return { kind: 'not-written', reason: 'path-refused' };
    const bytes = serializeBriefFile(args.file);
    try {
      const res = await args.store.writeFile({
        baseCommit: base,
        path,
        expect: existing ? 'regular-file' : 'absent',
        bytes,
        message: 'Vault Companion: morning brief',
        trailers: { [TRAILER_JOB]: MORNING_BRIEF_JOB_ID, [TRAILER_OP]: args.operationId },
      });
      if (res.ok) return { kind: 'committed', commitSha: res.commitSha, operationId: args.operationId };
      if (res.reason === 'precondition-failed') return { kind: 'not-written', reason: 'precondition-failed' };
    } catch (err) {
      if (!(err instanceof StoreUnknownOutcome)) throw err;
      unknown = true;
    }
  }
  return { kind: 'not-written', reason: unknown ? 'unknown-outcome' : 'head-moved' };
}
