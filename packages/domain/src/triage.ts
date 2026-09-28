import { MAX_NOTE_BYTES, type ApiError, type TriageResponse } from '@vault-companion/contracts';
import { parseDecisionLines, parseTriageApplied, parseTriageFeed } from './triage-format.ts';
import { parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type ListedFile, type VaultStore } from './store.ts';
import { userDate } from './time.ts';

export const TRIAGE_DIR = 'Events/Triage';
export function triageMonth(at: string | Date): string { return userDate(at, 'Europe/Copenhagen').slice(0, 7); }
export function triageDecisionPath(at: string | Date) { return parseVaultPath(`${TRIAGE_DIR}/Decisions/${triageMonth(at)}.jsonl`)!; }

/** Listing and blob must agree at the single pinned head; symlinks are never followed. */
export async function readTriageText(store: VaultStore, x: string, files: readonly ListedFile[], path: string): Promise<string | null> {
  const listed = files.find((file) => file.path === path);
  if (!listed) return null;
  const file = await store.readFile(parseVaultPath(path)!, x);
  if (!file || file.blobSha !== listed.blobSha) return null;
  if (file.bytes.length > MAX_NOTE_BYTES) throw new FileTooLarge();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
}

export function createTriageService(deps: { store: VaultStore; now?: () => Date }) {
  return {
    async readTriage(): Promise<TriageResponse | ApiError> {
      try {
        const now = deps.now?.() ?? new Date();
        const { commitSha: revision } = await deps.store.head();
        const files = await deps.store.listFiles(TRIAGE_DIR, revision);
        const read = async (path: string) => {
          try { return await readTriageText(deps.store, revision, files, path); }
          catch (e) { if (e instanceof FileTooLarge || e instanceof TypeError) return ''; throw e; }
        };
        const month = triageMonth(now);
        const previous = new Date(`${month}-01T12:00:00Z`);
        previous.setUTCMonth(previous.getUTCMonth() - 1);
        const [feed, applied, before, current] = await Promise.all([
          read(`${TRIAGE_DIR}/feed.json`), read(`${TRIAGE_DIR}/applied.json`), read(triageDecisionPath(previous)), read(triageDecisionPath(now)),
        ]);
        const decisions = [...parseDecisionLines(before), ...parseDecisionLines(current)].slice(-5000)
          .map(({ decisionId, eventId, decision, outcome, undoes, at, card }) =>
            ({ decisionId, eventId, decision, outcome, undoes, at, title: card.title, start: card.start }));
        return { revision, now: now.toISOString(), ...parseTriageFeed(feed), ...parseTriageApplied(applied), decisions };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return { code: 'upstream-unavailable', message: 'Triage could not be read right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
