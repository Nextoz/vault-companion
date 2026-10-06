import { ACTIVE_WORK_PATH, MAX_NOTE_BYTES, type ActiveWorkResponse, type ApiError } from '@vault-companion/contracts';
import { parseActiveWork } from '@vault-companion/vault-markdown';
import { userDate } from './time.ts';
import { parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from './store.ts';

export interface ActiveWorkServiceDeps {
  readonly store: VaultStore;
  readonly now?: () => Date;
  readonly timeZone?: string;
}

const PATH = parseVaultPath(ACTIVE_WORK_PATH)!;
const DIR = PATH.slice(0, PATH.lastIndexOf('/'));

async function read(store: VaultStore, today: string): Promise<ActiveWorkResponse> {
  const { commitSha: x } = await store.head();
  const refused = (code: 'too-large' | 'encoding', message: string): ActiveWorkResponse => ({ status: 'refused', revision: x, code, message });
  try {
    // Only a regular file is read: the Contents API follows a symlink, which could serve a note outside the allowlist.
    const listed = (await store.listFiles(DIR, x)).find((f) => f.path === PATH);
    if (!listed) return { status: 'absent', revision: x };
    const file = await store.readFile(PATH, x);
    if (!file || file.blobSha !== listed.blobSha) return { status: 'absent', revision: x };
    if (file.bytes.length > MAX_NOTE_BYTES) return refused('too-large', 'Active Work Now is larger than 1 MB');
    let markdown: string;
    try {
      markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
    } catch {
      return refused('encoding', 'Active Work Now is not valid UTF-8');
    }
    const parsed = parseActiveWork(markdown, today);
    const items = parsed.ok ? parsed.items.filter((t) => t.section === 'Now').map((t) => ({
      locator: { path: ACTIVE_WORK_PATH as typeof ACTIVE_WORK_PATH, blobSha: file.blobSha, lineIndex: t.lineIndex, lineText: t.lineText, occurrencesAtRead: t.occurrences, occurrenceIndex: t.occurrenceIndex },
      name: t.name, outcome: t.outcome, next: t.next, review: t.review, link: t.link, needsReview: t.needsReview,
    })) : [];
    return { status: 'ok', revision: x, blobSha: file.blobSha, markdown, items,
      unknownNowLines: parsed.ok ? parsed.unknownNowLines : [markdown], today };
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'Active Work Now is too large to read here');
    throw e;
  }
}

export function createActiveWorkService(deps: ActiveWorkServiceDeps) {
  return {
    async readActiveWork(): Promise<ActiveWorkResponse | ApiError> {
      try {
        return await read(deps.store, userDate(deps.now?.() ?? new Date(), deps.timeZone ?? 'Europe/Copenhagen'));
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
