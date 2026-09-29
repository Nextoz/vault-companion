// "This morning" (ADR-0029 Part 2, owner 2026-09-28/29): today's Reading Brief and the recent research explanations,
// read-only, pinned to one commit. The client renders the Markdown with the scout renderer (raw HTML off, sanitised).
import type { ApiError, LinkedNoteResponse, MorningResponse } from '@vault-companion/contracts';
import { readResolvedNote } from './linked-notes.ts';
import { EXPLAINED_DIR } from './paths.ts';
import { BRIEF_DIR, briefPath, PENDING_DAYS } from './research-explainer.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from './store.ts';
import { userDate } from './time.ts';

export interface MorningServiceDeps {
  readonly store: VaultStore;
  readonly now: () => Date;
  readonly timeZone: string;
}

/** At most this many explanations (5 a day, plus retries still within their window). */
export const MAX_MORNING_EXPLAINED = 10;

const daysBefore = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function read(deps: MorningServiceDeps): Promise<MorningResponse> {
  const { store } = deps;
  const date = userDate(deps.now(), deps.timeZone);
  const { commitSha: x } = await store.head();
  // Listings return regular files only with their blob SHA: a symlink can never stand in for a note.
  const brief = (await store.listFiles(BRIEF_DIR, x)).find((f) => f.path === briefPath(date));
  // Explanations of the carry-over window (ADR-0029 amendment 2): a paper retried today keeps its first-seen date.
  const days = new Set(Array.from({ length: PENDING_DAYS }, (_, i) => daysBefore(date, i)));
  const explained = (await store.listFiles(EXPLAINED_DIR, x))
    .filter((f) => !f.path.slice(EXPLAINED_DIR.length + 1).includes('/') && f.path.endsWith('.md') && days.has(f.path.slice(EXPLAINED_DIR.length + 1, EXPLAINED_DIR.length + 11)))
    .sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
    .slice(0, MAX_MORNING_EXPLAINED);
  // In parallel: every read is pinned to commit x, so order and consistency do not change (CodeRabbit #46).
  const [briefNote, ...notes] = await Promise.all([brief ? readResolvedNote(store, x, brief) : null, ...explained.map((f) => readResolvedNote(store, x, f))]);
  return { revision: x, date, brief: briefNote ?? null, explained: notes.filter((n): n is LinkedNoteResponse => n !== null) };
}

export function createMorningService(deps: MorningServiceDeps) {
  return {
    async readMorning(): Promise<MorningResponse | ApiError> {
      try {
        return await read(deps);
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
