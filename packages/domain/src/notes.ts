// ADR-0022: Inbox notes in the app — list and read. The only client-named path the app accepts, and only after it
// passes the Inbox note policy AND appears in the regular-file listing at the same pinned commit X.
import { MAX_NOTES_LISTED, type ApiError, type NoteReadResponse, type NotesResponse } from '@vault-companion/contracts';
import * as md from '@vault-companion/vault-markdown';
import { readResolvedNote } from './linked-notes.ts';
import { INBOX_DIR, isInboxNotePath } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type ListedFile, type VaultStore } from './store.ts';

export interface NotesServiceDeps {
  readonly store: VaultStore;
}

type NoteEntry = NotesResponse['notes'][number];

const DATED = /^(.*) - (\d{4}-\d{2}-\d{2})( \(\d+\))?\.md$/;

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Title and date from the file name alone (no contents are read for the list). */
export function noteEntry(f: ListedFile): NoteEntry {
  const name = f.path.slice(INBOX_DIR.length + 1);
  const m = DATED.exec(name);
  if (m && isRealDate(m[2]!)) return { path: f.path, title: m[1]! + (m[3] ?? ''), date: m[2]!, blobSha: f.blobSha };
  return { path: f.path, title: name.slice(0, -'.md'.length), date: null, blobSha: f.blobSha };
}

/** Newest date first; within a date, and for undated names (after all dated ones), by name. */
export function compareNotes(a: NoteEntry, b: NoteEntry): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  // By title first so a collision name `X (2)` follows `X` (a raw path compare puts " (2).md" before ".md").
  const byTitle = a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  return byTitle || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Regular files directly in Inbox/ that pass the note policy (symlinks never appear in `listFiles`). */
async function listInbox(store: VaultStore, x: string): Promise<readonly ListedFile[]> {
  return (await store.listFiles(INBOX_DIR, x)).filter((f) => isInboxNotePath(f.path));
}

const tooLarge: ApiError = { code: 'refused:too-large', message: 'the Inbox folder is too large to list', retryable: false };

export function createNotesService(deps: NotesServiceDeps) {
  const guarded = async <T>(run: () => Promise<T>): Promise<T | ApiError> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof FileTooLarge) return tooLarge;
      if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) {
        return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
      }
      throw e;
    }
  };

  return {
    listNotes(): Promise<NotesResponse | ApiError> {
      return guarded(async () => {
        const { commitSha: x } = await deps.store.head();
        const notes = (await listInbox(deps.store, x)).map(noteEntry).sort(compareNotes).slice(0, MAX_NOTES_LISTED);
        return { revision: x, notes };
      });
    },

    readNote(path: string): Promise<NoteReadResponse | ApiError> {
      return guarded(async (): Promise<NoteReadResponse> => {
        const { commitSha: x } = await deps.store.head();
        if (!isInboxNotePath(path)) return { status: 'refused', revision: x, code: 'outside-allowlist', message: 'only notes directly in Inbox/ can be opened here' };
        const listed = (await listInbox(deps.store, x)).find((f) => f.path === path);
        if (!listed) return { status: 'refused', revision: x, code: 'not-found', message: 'the note does not exist any more; reload the list' };
        // Same guards as a linked note: the listed blob, the 1 MB cap, UTF-8.
        const note = await readResolvedNote(deps.store, x, listed);
        if (note.status !== 'ok') return note;
        const fm = md.noteFrontmatterLength(note.markdown);
        return { ...note, path, frontmatter: note.markdown.slice(0, fm), body: note.markdown.slice(fm) };
      });
    },
  };
}
