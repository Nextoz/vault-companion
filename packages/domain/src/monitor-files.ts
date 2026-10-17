// M6a: read-only projection of the vault activity (heatmap) JSON the vault-side PC script emits. The path is a
// constant, the file is re-validated on every read, and no note count, area name or excluded prefix ever leaves
// this module in an error or log.
import { JobRadarFile, VaultActivityFile, type ApiError, type JobRadarResponse, type VaultActivityResponse } from '@vault-companion/contracts';
import { z } from 'zod';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

/** M6a: the one fixed file the vault-side writer emits. A constant, never client input. */
export const VAULT_ACTIVITY_PATH = 'Automation/Monitors/vault-activity.json';

/** M5a: the one fixed job radar file the vault-side writer emits. A constant, never client input. */
export const JOB_RADAR_PATH = 'Automation/Monitors/job-radar.json';

/**
 * Read one fixed monitor file: listed at the head commit, read with a matching blob SHA, fatal-decoded as UTF-8,
 * then validated against `schema`. Never throws; a store outage is a retryable upstream-unavailable.
 */
export async function readMonitorFile<S extends z.ZodType>(
  store: VaultStore,
  path: string,
  schema: S,
  what: string,
): Promise<{ revision: string; data: z.infer<S> } | ApiError> {
  try {
    const { commitSha: revision } = await store.head();
    // Listed like scout status files: only a regular file can stand in, and its blob proves what was read.
    const dir = path.slice(0, path.lastIndexOf('/'));
    const listed = (await store.listFiles(dir, revision)).find((f) => f.path === path);
    if (!listed) return { code: 'not-found', message: `the ${what} does not exist`, retryable: false };
    const file = await store.readFile(path as VaultPath, revision);
    if (!file || file.blobSha !== listed.blobSha) return { code: 'invalid', message: `the ${what} could not be read safely`, retryable: false };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes));
    } catch {
      return { code: 'invalid', message: `the ${what} could not be read safely`, retryable: false };
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { code: 'invalid', message: `the ${what} could not be read safely`, retryable: false };
    return { revision, data: parsed.data };
  } catch (e) {
    if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
      return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
    }
    throw e;
  }
}

export interface VaultActivityReadDeps {
  readonly store: VaultStore;
}

export function createVaultActivityReadService(deps: VaultActivityReadDeps) {
  return {
    async readVaultActivity(): Promise<VaultActivityResponse | ApiError> {
      const result = await readMonitorFile(deps.store, VAULT_ACTIVITY_PATH, VaultActivityFile, 'vault activity file');
      if ('code' in result) return result;
      return { revision: result.revision, ...result.data };
    },
  };
}

export interface JobRadarReadDeps {
  readonly store: VaultStore;
}

export function createJobRadarReadService(deps: JobRadarReadDeps) {
  return {
    async readJobRadar(): Promise<JobRadarResponse | ApiError> {
      const result = await readMonitorFile(deps.store, JOB_RADAR_PATH, JobRadarFile, 'job radar file');
      if ('code' in result) return result;
      return { revision: result.revision, ...result.data };
    },
  };
}
