// AB3a: read-only projection of the one AI usage summary JSON (ADR-0051). The path is a constant, the file is
// re-validated on every read, and providers/days are parsed one by one: an unknown provider id is kept, a malformed
// provider or day drops only itself and counts in `skipped`. No provider value ever leaves this module in an error or log.
import { AiUsageDay, AiUsageProvider, type AiUsageResponse, type ApiError } from '@vault-companion/contracts';
import { z } from 'zod';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

/** ADR-0051: the one fixed file the vault-side writer emits. A constant, never client input. */
export const AI_USAGE_PATH = 'AI/Usage/AI Usage Summary.json';

const PATH = AI_USAGE_PATH as VaultPath;
const DIR = AI_USAGE_PATH.slice(0, AI_USAGE_PATH.lastIndexOf('/'));

/**
 * The envelope; `providers` stays unknown so a single bad provider can be dropped without failing the file, and extra
 * fields are ignored (not stripped as an error) so the vault side can add fields the reader does not know yet.
 */
const UsageFile = z.object({
  schema: z.literal(1),
  generatedAt: z.iso.datetime({ offset: true }),
  providers: z.record(z.string(), z.unknown()),
});

/** A provider with its raw `days` still unparsed, so each day can be validated on its own. */
const ProviderEntry = z.object({
  label: z.string().optional(),
  currency: z.string().optional(),
  days: z.array(z.unknown()),
  since: z.iso.date().optional(),
});

export interface AiUsageFile {
  readonly generatedAt: string;
  readonly providers: Record<string, AiUsageProvider>;
  readonly skipped: number;
}

/** Parse raw bytes/text/JSON; never throws. A bad envelope is null; a bad provider or day is skipped on its own. */
export function parseAiUsageFile(raw: unknown): AiUsageFile | null {
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
  const envelope = UsageFile.safeParse(value);
  if (!envelope.success) return null;
  const providers: Record<string, AiUsageProvider> = {};
  let skipped = 0;
  for (const [id, entry] of Object.entries(envelope.data.providers)) {
    const provider = ProviderEntry.safeParse(entry);
    if (!provider.success) {
      skipped++;
      continue;
    }
    const days: AiUsageDay[] = [];
    for (const day of provider.data.days) {
      const parsed = AiUsageDay.safeParse(day);
      if (parsed.success) days.push(parsed.data);
      else skipped++;
    }
    const projected = AiUsageProvider.safeParse({ ...provider.data, days });
    if (!projected.success) {
      skipped++;
      continue;
    }
    providers[id] = projected.data;
  }
  return { generatedAt: envelope.data.generatedAt, providers, skipped };
}

export interface AiUsageReadDeps {
  readonly store: VaultStore;
}

export function createAiUsageReadService(deps: AiUsageReadDeps) {
  return {
    async readAiUsage(): Promise<AiUsageResponse | ApiError> {
      try {
        const { commitSha: revision } = await deps.store.head();
        // Listed like scout status files: only a regular file can stand in, and its blob proves what was read.
        const listed = (await deps.store.listFiles(DIR, revision)).find((f) => f.path === AI_USAGE_PATH);
        if (!listed) return { code: 'not-found', message: 'the AI usage summary does not exist', retryable: false };
        const file = await deps.store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { code: 'invalid', message: 'the AI usage summary could not be read safely', retryable: false };
        const parsed = parseAiUsageFile(file.bytes);
        if (!parsed) return { code: 'invalid', message: 'the AI usage summary is not valid JSON', retryable: false };
        return { revision, generatedAt: parsed.generatedAt, providers: parsed.providers, skipped: parsed.skipped };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}