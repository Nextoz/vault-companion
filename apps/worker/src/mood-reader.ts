// Morning Brief mood reader (ADR-0036 read side): the two Daily notes the app writes check-ins into, read through the
// caller's pinned-head store. Missing notes mean "no check-in yet" (empty), never unavailable; only a failed read is.
import { type ApiError, type MoodCheckinPayload } from '@vault-companion/contracts';
import { dailyJournalPath, FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from '@vault-companion/domain';
import { parseMoodCheckin } from '@vault-companion/vault-markdown';

/** The calendar day immediately before `day` in Europe/Copenhagen date terms (a valid date is assumed by the caller). */
function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! - 1)).toISOString().slice(0, 10);
}

function decode(file: { readonly bytes: Uint8Array }): string | ApiError {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    return { code: 'refused:encoding', message: 'Daily journal is not valid UTF-8', retryable: false };
  }
}

export interface MoodReader {
  /** Today's and yesterday's check-ins, newest first by reader order; the gatherer picks the newest. */
  readMood(day: string): Promise<readonly MoodCheckinPayload[] | ApiError>;
}

export function createMoodReader({ store }: { store: VaultStore }): MoodReader {
  return {
    async readMood(day) {
      try {
        const { commitSha: revision } = await store.head();
        const checkins: MoodCheckinPayload[] = [];
        for (const date of [day, previousDay(day)]) {
          const path = dailyJournalPath(date);
          if (!path) continue;
          const file = await store.readFile(path, revision);
          if (!file) continue;
          const source = decode(file);
          if (typeof source !== 'string') return source;
          const parsed = parseMoodCheckin(source, date);
          if (parsed) checkins.push({ date, ...parsed });
        }
        return checkins;
      } catch (err) {
        if (err instanceof FileTooLarge) return { code: 'refused:too-large', message: 'Daily journal is too large to read', retryable: false };
        if (err instanceof StoreUnavailable || err instanceof StoreUnknownOutcome) {
          return { code: 'upstream-unavailable', message: 'Vault is not reachable right now', retryable: true };
        }
        throw err;
      }
    },
  };
}
