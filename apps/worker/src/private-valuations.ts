// WL4b: read-only projection of the one hand-edited private-valuations JSON. The path is a constant, the file is
// re-validated on every read, and entries are parsed one by one: a malformed entry (bad date, non-https source, a
// non-positive or non-finite value, a duplicate id) drops only itself and counts in `skipped`. No value or note text
// ever leaves this module in an error or log. There is no write target: the vault file is hand-edited.
import { PrivateValuationItem } from '@vault-companion/contracts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from '@vault-companion/domain';

/** The one fixed file the owner hand-edits. A constant, never client input. */
export const PRIVATE_VALUATIONS_PATH = 'Automation/Watchlist/private-valuations.json';

const PATH = PRIVATE_VALUATIONS_PATH as VaultPath;
const DIR = PRIVATE_VALUATIONS_PATH.slice(0, PRIVATE_VALUATIONS_PATH.lastIndexOf('/'));

export interface ParsedPrivateValuations {
  readonly items: readonly PrivateValuationItem[];
  readonly skipped: number;
}

/** Parse raw bytes/text/JSON; never throws. A bad envelope is null; a bad entry is dropped on its own and counted. */
export function parsePrivateValuationsFile(raw: unknown): ParsedPrivateValuations | null {
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
  // The envelope is checked by hand (the worker has no zod dependency); each entry is then validated by the contract.
  if (typeof value !== 'object' || value === null) return null;
  const envelope = value as { schemaVersion?: unknown; items?: unknown };
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.items)) return null;
  const items: PrivateValuationItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of envelope.items) {
    const parsed = PrivateValuationItem.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      skipped++;
      continue;
    }
    seen.add(parsed.data.id);
    items.push(parsed.data);
  }
  return { items, skipped };
}

export type PrivateValuationsReadResult =
  | { readonly status: 'ok'; readonly revision: string; readonly items: readonly PrivateValuationItem[]; readonly skipped: number }
  | { readonly status: 'not-found' }
  | { readonly status: 'invalid' };

export interface PrivateValuationsReadDeps {
  readonly store: VaultStore;
}

export interface PrivateValuationsReader {
  readPrivateValuations(): Promise<PrivateValuationsReadResult>;
}

export function createPrivateValuationsReader(deps: PrivateValuationsReadDeps): PrivateValuationsReader {
  return {
    async readPrivateValuations(): Promise<PrivateValuationsReadResult> {
      try {
        const { commitSha: revision } = await deps.store.head();
        // Listed like scout status files: only a regular file can stand in, and its blob proves what was read.
        const listed = (await deps.store.listFiles(DIR, revision)).find((f) => f.path === PRIVATE_VALUATIONS_PATH);
        if (!listed) return { status: 'not-found' };
        const file = await deps.store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { status: 'invalid' };
        const parsed = parsePrivateValuationsFile(file.bytes);
        if (!parsed) return { status: 'invalid' };
        return { status: 'ok', revision, items: parsed.items, skipped: parsed.skipped };
      } catch (e) {
        // A store outage has no dedicated card reason: it is shown as an unreadable file, never as a number.
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) return { status: 'invalid' };
        throw e;
      }
    },
  };
}
