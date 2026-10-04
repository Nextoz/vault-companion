import { LEARNING_PATH, MAX_NOTE_BYTES, type ApiError, type LearningResponse } from '@vault-companion/contracts';
import { parseLearning } from '@vault-companion/vault-markdown';
import { parseVaultPath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultStore } from './store.ts';

const PATH = parseVaultPath(LEARNING_PATH)!;

export function createLearningService({ store }: { store: VaultStore }) {
  return { async readLearning(): Promise<LearningResponse | ApiError> {
    try {
      const { commitSha: revision } = await store.head();
      try {
        const listed = (await store.listFiles('Personal', revision)).find((f) => f.path === PATH);
        if (!listed) return { status: 'absent', revision };
        const file = await store.readFile(PATH, revision);
        if (!file || file.blobSha !== listed.blobSha) return { status: 'absent', revision };
        if (file.bytes.length > MAX_NOTE_BYTES) throw new FileTooLarge('learning');
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes); }
        catch { return { status: 'refused', revision, code: 'refused:encoding', message: 'Learning Gym Log is not valid UTF-8' }; }
        const parsed = parseLearning(source);
        if (!parsed.ok) return { status: 'refused', revision, code: parsed.code, message: parsed.message };
        const kinds = parsed.kinds.map(({ id, name, scoreMeans, status }) => ({ id, name, scoreMeans, status }));
        const rows = parsed.rows.map(({ date, kind, minutes, score, detail, topic, note }) => ({ date, kind, minutes, score, detail, topic, note }));
        rows.sort((a, b) => b.date.localeCompare(a.date));
        return { status: 'ok', revision, blobSha: file.blobSha, kinds, rows, unknownLines: parsed.unknownLines };
      } catch (e) {
        if (e instanceof FileTooLarge) return { status: 'refused', revision, code: 'refused:too-large', message: 'Learning Gym Log is too large to read here' };
        throw e;
      }
    } catch (e) {
      if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
      throw e;
    }
  } };
}
