import { TRAINING_PATH, MAX_NOTE_BYTES, type TrainingResponse, type ApiError } from '@vault-companion/contracts';
import { parseTraining } from '@vault-companion/vault-markdown';
import { parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from './store.ts';

const PATH = parseVaultPath(TRAINING_PATH)!;
export function createTrainingService({ store }: { store: VaultStore }) {
  return { async readTraining(): Promise<TrainingResponse | ApiError> {
    try {
      const { commitSha: revision } = await store.head();
      try {
        const listed = (await store.listFiles('Health', revision)).find((f) => f.path === PATH);
        if (!listed) return { status: 'absent', revision };
        const file = await store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { status: 'absent', revision };
        if (file.bytes.length > MAX_NOTE_BYTES) throw new FileTooLarge('training');
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
        catch { return { status: 'refused', revision, code: 'refused:encoding', message: 'Training log is not valid UTF-8' }; }
        const parsed = parseTraining(source);
        if (!parsed.ok) return { status: 'refused', revision, code: parsed.code, message: parsed.message };
        const rows = parsed.rows.map(({ date, time, type, distance, duration, weight, split, note }) => ({ date, time, type, distance, duration, weight, split, note }));
        rows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
        return { status: 'ok', revision, blobSha: file.blobSha, rows, unknownLines: parsed.unknownLines };
      } catch (e) {
        if (e instanceof FileTooLarge) return { status: 'refused', revision, code: 'refused:too-large', message: 'Training log is too large to read here' };
        throw e;
      }
    } catch (e) {
      if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
      throw e;
    }
  } };
}
