import { SCOUT_STATUS_DIR, ScoutStatus, type ScoutsResponse, type ApiError, type LinkedNoteResponse } from '@vault-companion/contracts';
import { readResolvedNote } from './linked-notes.ts';
import { canReadScoutOutput, parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type ListedFile, type VaultStore } from './store.ts';

export interface ScoutServiceDeps {
  readonly store: VaultStore;
  readonly now?: () => Date;
}

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_SCOUTS = 50;
// Registry files that share the status directory but are not scouts (ADR-0049 AI budget).
const NON_SCOUT_FILES: ReadonlySet<string> = new Set(['ai-budget.json']);
type ScoutEntry = ScoutsResponse['scouts'][number];

async function statusFiles(store: VaultStore, x: string): Promise<readonly ListedFile[]> {
  const prefix = `${SCOUT_STATUS_DIR}/`;
  return (await store.listFiles(SCOUT_STATUS_DIR, x))
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/') && f.path.endsWith('.json') && !NON_SCOUT_FILES.has(f.path.slice(prefix.length)))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .slice(0, MAX_SCOUTS);
}

async function readStatus(store: VaultStore, x: string, listed: ListedFile): Promise<ScoutEntry> {
  const unreadable: ScoutEntry = { state: 'unreadable', file: listed.path };
  const path = parseVaultPath(listed.path);
  if (!path) return unreadable;
  let file;
  try {
    file = await store.readFile(path, x);
  } catch (e) {
    if (e instanceof FileTooLarge) return unreadable;
    throw e;
  }
  if (!file || file.blobSha !== listed.blobSha || file.bytes.length > MAX_STATUS_BYTES) return unreadable;
  try {
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
    // Normalise before schema validation: ScoutStatus caps the displayed error at 200 characters.
    if (raw && typeof raw === 'object' && 'lastError' in raw && typeof raw.lastError === 'string') {
      raw.lastError = raw.lastError.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').slice(0, 200);
    }
    const parsed = ScoutStatus.safeParse(raw);
    return parsed.success ? { state: 'ok', file: listed.path, status: parsed.data } : unreadable;
  } catch {
    return unreadable;
  }
}

async function readOutput(store: VaultStore, scoutId: string): Promise<LinkedNoteResponse> {
  const { commitSha: x } = await store.head();
  const refused = (code: 'not-found' | 'outside-allowlist' | 'too-large', message: string): LinkedNoteResponse =>
    ({ status: 'refused', revision: x, code, message });
  if (!ScoutStatus.shape.scoutId.safeParse(scoutId).success) return refused('not-found', 'unknown scout');
  try {
    // Resolve by the schema's ID, not a client-supplied filename. Ambiguous IDs fail closed.
    let match: ScoutStatus | undefined;
    for (const listed of await statusFiles(store, x)) {
      const entry = await readStatus(store, x, listed);
      if (entry.state !== 'ok' || entry.status.scoutId !== scoutId) continue;
      if (match) return refused('not-found', 'scout ID is ambiguous');
      match = entry.status;
    }
    // Vault paths are compared in NFC (vault-contract §1): a decomposed name written by another tool still matches.
    const path = match?.latestOutput?.normalize('NFC');
    if (!path) return refused('not-found', 'the scout has no output note');
    if (!canReadScoutOutput(path)) return refused('outside-allowlist', 'the output path is not allowed');
    // Root-level notes are supported too; the store's recursive root listing uses an empty directory.
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const listed = (await store.listFiles(dir, x)).find((f) => f.path.normalize('NFC') === path);
    if (!listed) return refused('not-found', 'the output note does not exist');
    return await readResolvedNote(store, x, listed);
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'the folder is too large to search');
    throw e;
  }
}

export function createScoutService(deps: ScoutServiceDeps) {
  const guarded = async <T>(read: () => Promise<T>): Promise<T | ApiError> => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
        return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
      }
      throw e;
    }
  };
  return {
    readScouts(): Promise<ScoutsResponse | ApiError> {
      return guarded(async () => {
        const { commitSha: x } = await deps.store.head();
        const scouts: ScoutEntry[] = [];
        for (const listed of await statusFiles(deps.store, x)) scouts.push(await readStatus(deps.store, x, listed));
        return { revision: x, now: (deps.now?.() ?? new Date()).toISOString(), scouts };
      });
    },
    readScoutOutput(scoutId: string): Promise<LinkedNoteResponse | ApiError> {
      return guarded(() => readOutput(deps.store, scoutId));
    },
  };
}
