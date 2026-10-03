// AB2: read-only projection of the one AI budget JSON the vault-side writer (AB1, ADR-0049) emits. The path is a
// constant, the file is re-validated on every read, and an unknown provider id/kind drops only that provider. No
// provider value ever leaves this module in an error or log.
import { AiBudgetProvider, type AiBudgetResponse, type ApiError } from '@vault-companion/contracts';
import { z } from 'zod';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

/** ADR-0049: the one fixed file the vault-side writer emits. A constant, never client input. */
export const AI_BUDGET_PATH = 'Automation/Scout Status/ai-budget.json';

const PATH = AI_BUDGET_PATH as VaultPath;
const DIR = AI_BUDGET_PATH.slice(0, AI_BUDGET_PATH.lastIndexOf('/'));

/** The strict envelope; `providers` stays unknown so a single bad entry can be dropped without failing the file. */
const BudgetFile = z.strictObject({
  schema: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  providers: z.array(z.unknown()),
  freeRamGb: z.number().nullable(),
});

export interface AiBudgetFile {
  readonly generatedAt: string;
  readonly providers: AiBudgetProvider[];
  readonly freeRamGb: number | null;
}

/** Parse raw bytes/text/JSON; never throws. A bad envelope is null; a bad provider is skipped on its own. */
export function parseAiBudgetFile(raw: unknown): AiBudgetFile | null {
  let value = raw;
  if (value instanceof Uint8Array) {
    try {
      value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const envelope = BudgetFile.safeParse(value);
  if (!envelope.success) return null;
  const providers: AiBudgetProvider[] = [];
  for (const entry of envelope.data.providers) {
    const provider = AiBudgetProvider.safeParse(entry);
    if (provider.success) providers.push(provider.data);
  }
  return { generatedAt: envelope.data.generatedAt, providers, freeRamGb: envelope.data.freeRamGb };
}

export interface AiBudgetReadDeps {
  readonly store: VaultStore;
}

export function createAiBudgetReadService(deps: AiBudgetReadDeps) {
  return {
    async readAiBudget(): Promise<AiBudgetResponse | ApiError> {
      try {
        const { commitSha: revision } = await deps.store.head();
        // Listed like scout status files: only a regular file can stand in, and its blob proves what was read.
        const listed = (await deps.store.listFiles(DIR, revision)).find((f) => f.path === AI_BUDGET_PATH);
        if (!listed) return { code: 'not-found', message: 'the AI budget does not exist', retryable: false };
        const file = await deps.store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { code: 'invalid', message: 'the AI budget could not be read safely', retryable: false };
        const parsed = parseAiBudgetFile(file.bytes);
        if (!parsed) return { code: 'invalid', message: 'the AI budget is not valid JSON', retryable: false };
        return { revision, generatedAt: parsed.generatedAt, providers: parsed.providers, freeRamGb: parsed.freeRamGb };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
