// Active Work Now card (ADR-0012 "chosen work"): the owner's hand-kept `Tasks/Active Work Now.md`, read-only, at one
// pinned commit. No task mapping is inferred from it and nothing is ever written to it (vault-contract §7).
import { ACTIVE_WORK_PATH, MAX_NOTE_BYTES, type ActiveWorkResponse, type ApiError } from '@vault-companion/contracts';
import { parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from './store.ts';

export interface ActiveWorkServiceDeps {
  readonly store: VaultStore;
}

const PATH = parseVaultPath(ACTIVE_WORK_PATH)!;
const DIR = PATH.slice(0, PATH.lastIndexOf('/'));

async function read(store: VaultStore): Promise<ActiveWorkResponse> {
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
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    } catch {
      return refused('encoding', 'Active Work Now is not valid UTF-8');
    }
    return { status: 'ok', revision: x, blobSha: file.blobSha, markdown };
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'Active Work Now is too large to read here');
    throw e;
  }
}

export function createActiveWorkService(deps: ActiveWorkServiceDeps) {
  return {
    async readActiveWork(): Promise<ActiveWorkResponse | ApiError> {
      try {
        return await read(deps.store);
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
