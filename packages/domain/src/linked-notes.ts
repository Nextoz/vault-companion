// Read-only linked notes (vault-contract §1 "Linked notes", security.md "Rendering", brief P4-A).
// The server resolves the n-th wikilink of a task line at one pinned commit X; a client-supplied path is never read.
import { MAX_NOTE_BYTES, type ApiError, type LinkedNoteRefusalCode, type LinkedNoteRequest, type LinkedNoteResponse, type TaskLocator } from '@vault-companion/contracts';
import * as md from '@vault-companion/vault-markdown';
import { canReadLinkedNote, isStructurallySafePath, LINKED_NOTE_ROOTS, parseVaultPath, TODO_LIST_PATH } from './paths.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type ListedFile, type VaultPath, type VaultStore } from './store.ts';

export interface LinkedNoteServiceDeps {
  readonly store: VaultStore;
}

type Resolved = { readonly ok: true; readonly path: string; readonly blobSha: string } | { readonly ok: false; readonly code: LinkedNoteRefusalCode; readonly message: string };

const no = (code: LinkedNoteRefusalCode, message: string): Resolved => ({ ok: false, code, message });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * vault-contract §3 resolution over the indexed tasks at X, as the kernel does for writes. Any outcome other than one
 * resolved task — changed, removed or ambiguous — is `task-changed` for a read: the fix is the same (reload the list).
 */
export function locateTask(tasks: readonly md.ParsedTask[], loc: TaskLocator, blobShaAtX: string): md.ParsedTask | null {
  if (blobShaAtX === loc.blobSha) {
    const exact = tasks.find((t) => t.lineIndex === loc.lineIndex);
    if (exact && exact.lineText === loc.lineText) return exact;
  }
  if (loc.occurrencesAtRead !== 1) return null;
  const matches = tasks.filter((t) => t.lineText === loc.lineText);
  return matches.length === 1 ? matches[0]! : null;
}

const fold = (s: string) => s.normalize('NFC').toLowerCase();
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Wikilink target → one allowlisted regular file at X. Exact vault-relative path when the target contains `/`, else the
 * unique basename among allowlisted roots (case-insensitive, like Obsidian and the Inbox collision rule); 0 or ≥ 2
 * matches refuse. Only paths from a regular-file listing are returned, so a symlink can never be followed.
 */
export async function resolveWikilink(store: VaultStore, at: string, target: string): Promise<Resolved> {
  const t = target.normalize('NFC');
  // Checked before `.md` is appended, so `[[..]]` cannot become the harmless-looking name `...md`.
  if (!isStructurallySafePath(t)) return no('outside-allowlist', 'the link points outside the notes this app may open');
  const withExt = t.endsWith('.md') ? t : `${t}.md`;
  const list = async (root: string): Promise<readonly ListedFile[] | 'too-large'> => {
    try {
      return await store.listFiles(root, at);
    } catch (e) {
      if (e instanceof FileTooLarge) return 'too-large';
      throw e;
    }
  };
  // A listed path is a candidate only if it passes the same policy a typed path would.
  const allowed = (f: ListedFile) => {
    const p = parseVaultPath(f.path);
    return p !== null && canReadLinkedNote(p);
  };

  if (t.includes('/')) {
    const path = parseVaultPath(withExt);
    if (!path || !canReadLinkedNote(path)) return no('outside-allowlist', 'the link points outside the notes this app may open');
    const files = await list(path.split('/')[0]!);
    if (files === 'too-large') return no('too-large', 'the folder is too large to search');
    const hit = files.find((f) => f.path.normalize('NFC') === path && allowed(f));
    return hit ? { ok: true, path: hit.path, blobSha: hit.blobSha } : no('not-found', 'the linked note does not exist');
  }

  const key = fold(withExt);
  const matches: ListedFile[] = [];
  for (const root of LINKED_NOTE_ROOTS) {
    const files = await list(root);
    if (files === 'too-large') return no('too-large', 'a folder is too large to search');
    for (const f of files) if (fold(basename(f.path)) === key && allowed(f)) matches.push(f);
  }
  if (matches.length === 0) return no('not-found', 'no note with that name');
  if (matches.length > 1) return no('ambiguous', 'several notes have that name; open it in Obsidian');
  return { ok: true, path: matches[0]!.path, blobSha: matches[0]!.blobSha };
}

async function read(store: VaultStore, req: LinkedNoteRequest): Promise<LinkedNoteResponse> {
  // One immutable commit X for the task list, the listing and the note (same pinning as task reads, review F1).
  const { commitSha: x } = await store.head();
  const refused = (code: LinkedNoteRefusalCode, message: string): LinkedNoteResponse => ({ status: 'refused', revision: x, code, message });

  let todo;
  try {
    todo = await store.readFile(TODO_LIST_PATH as VaultPath, x);
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'the task list is too large to read here');
    throw e;
  }
  const text = todo ? decodeUtf8(todo.bytes) : null;
  const parsed = text === null ? null : md.parseTodoList(text);
  if (!todo || !parsed?.ok) return refused('task-changed', 'the task list changed; reload it');
  const task = locateTask(parsed.tasks, req.taskLocator, todo.blobSha);
  if (!task) return refused('task-changed', 'the task changed since it was loaded; reload the list');
  const target = task.links[req.linkIndex];
  if (target === undefined) return refused('not-found', 'the task has no link at that position');

  const resolved = await resolveWikilink(store, x, target);
  if (!resolved.ok) return refused(resolved.code, resolved.message);

  let file;
  try {
    file = await store.readFile(resolved.path as VaultPath, x);
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'the note is larger than 1 MB');
    throw e;
  }
  if (!file) return refused('not-found', 'the linked note does not exist');
  // Defence in depth: the bytes must be the listed regular file's blob, never what a symlink or redirect served.
  if (file.blobSha !== resolved.blobSha) return refused('outside-allowlist', 'the note could not be read safely');
  if (file.bytes.length > MAX_NOTE_BYTES) return refused('too-large', 'the note is larger than 1 MB');
  const markdown = decodeUtf8(file.bytes);
  if (markdown === null) return refused('encoding', 'the note is not valid UTF-8');
  return { status: 'ok', revision: x, path: resolved.path, blobSha: file.blobSha, markdown };
}

export function createLinkedNoteService(deps: LinkedNoteServiceDeps) {
  return {
    async readLinkedNote(req: LinkedNoteRequest): Promise<LinkedNoteResponse | ApiError> {
      try {
        return await read(deps.store, req);
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) {
          return { code: 'upstream-unavailable', message: 'GitHub is not reachable right now', retryable: true };
        }
        throw e;
      }
    },
  };
}
