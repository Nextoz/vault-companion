// ADR-0062 read model: every book note under `Books/` (never the reading queue). Read-only, no writes here.
import { BOOKS_DIR, MAX_NOTE_BYTES, type ApiError, type BookView, type BooksResponse } from '@vault-companion/contracts';
import { parseBookNote } from '@vault-companion/vault-markdown';
import { isBookNotePath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type VaultPath, type VaultStore } from './store.ts';

export function createBooksService({ store }: { store: VaultStore }) {
  return {
    async readBooks(): Promise<BooksResponse | ApiError> {
      try {
        const { commitSha: revision } = await store.head();
        try {
          const listed = (await store.listFiles(BOOKS_DIR, revision)).filter((f) => isBookNotePath(f.path));
          const books: BookView[] = [];
          for (const file of listed) {
            const path = file.path as VaultPath;
            const read = await store.readFile(path, revision);
            if (!read || read.blobSha !== file.blobSha) continue;
            if (read.bytes.length > MAX_NOTE_BYTES) throw new FileTooLarge('books');
            let source: string;
            try {
              source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
            } catch {
              return { status: 'refused', revision, code: 'refused:encoding', message: 'A book note is not valid UTF-8' };
            }
            const parsed = parseBookNote(source);
            // A file that is not a readable book note is skipped: only notes the app can project become books.
            if (!parsed.ok || parsed.frontmatter.type !== 'book') continue;
            books.push({
              title: file.path.slice(BOOKS_DIR.length + 1, -'.md'.length),
              author: parsed.frontmatter.author,
              totalPages: parsed.frontmatter.totalPages ?? 0,
              currentPage: parsed.currentPage,
              status: parsed.frontmatter.status,
              lastRead: parsed.lastRead,
              reflections: parsed.reflections.map(({ date, text }) => ({ date, text })),
            });
          }
          books.sort((a, b) => a.title.localeCompare(b.title));
          return { status: 'ok', revision, books };
        } catch (e) {
          if (e instanceof FileTooLarge) return { status: 'refused', revision, code: 'refused:too-large', message: 'The books folder is too large to read here' };
          throw e;
        }
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        throw e;
      }
    },
  };
}
