// MB2: read-only projection of the one Morning Brief JSON the cron writes (ADR-0046). The path is a constant fresh
// from HEAD, the file is re-validated on every read, and no brief text ever leaves this module in an error or log.
import { ScoutStatus, type ApiError, type MorningBriefReadResponse } from '@vault-companion/contracts';
import { parseBriefFile } from './morning-brief-file.ts';
import { MORNING_BRIEF_PATH, MORNING_BRIEF_STATUS_PATH } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

export interface MorningBriefReadDeps {
  readonly store: VaultStore;
}

/** The one fixed source. A constant, never client input; `parseVaultPath` accepts exactly this path. */
const PATH = MORNING_BRIEF_PATH as VaultPath;
const DIR = MORNING_BRIEF_PATH.slice(0, MORNING_BRIEF_PATH.lastIndexOf('/'));
const STATUS_PATH = MORNING_BRIEF_STATUS_PATH as VaultPath;

function statusError(bytes: Uint8Array): string | null {
  try {
    const parsed = ScoutStatus.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data.lastError : null;
  } catch {
    return null;
  }
}

export function createMorningBriefReadService(deps: MorningBriefReadDeps) {
  return {
    async readMorningBrief(): Promise<MorningBriefReadResponse | ApiError> {
      try {
        const { commitSha: revision } = await deps.store.head();
        // Listed like linked notes: only a regular file can stand in, and its blob proves what was read.
        const listed = (await deps.store.listFiles(DIR, revision)).find((f) => f.path === MORNING_BRIEF_PATH);
        if (!listed) {
          const status = await deps.store.readFile(STATUS_PATH, revision);
          return { kind: 'missing', revision, statusError: status ? statusError(status.bytes) : null };
        }
        const file = await deps.store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { code: 'invalid', message: 'the morning brief could not be read safely', retryable: false };
        const parsed = parseBriefFile(file.bytes);
        if (!parsed) return { code: 'invalid', message: 'the morning brief is not valid JSON', retryable: false };
        return {
          revision,
          date: parsed.date,
          generatedAt: parsed.generatedAt,
          source: parsed.source,
          unavailable: parsed.unavailable,
          brief: parsed.brief,
        };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
