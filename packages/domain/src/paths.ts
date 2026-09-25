// Path policy: docs/vault-contract.md §1. Every path passes here before an adapter sees it.
import type { VaultPath } from './store.ts';

export const TODO_LIST_PATH = 'Tasks/To-Do List.md';
export const INBOX_DIR = 'Inbox';

const DENIED_ROOTS = new Set(['.git', '.obsidian', '.trash', 'Tools', 'tmp', 'output']);
/** Owner decision D2 default: linked notes are readable only under these roots (vault-contract §1, review A8). */
const LINKED_NOTE_ALLOWED_ROOTS = new Set(['Projects', 'Tasks', 'Inbox']);

/** C0, DEL, C1, and the Unicode line/paragraph separators: never legitimate in a vault path. */
function hasForbiddenChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/**
 * Structural safety only (no scope policy): the defence-in-depth check every adapter runs on every path it
 * receives, even though callers pass `parseVaultPath` output (security.md#paths, review A8/R5).
 */
export function isStructurallySafePath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 512) return false;
  if (hasForbiddenChar(raw) || raw.includes('\\') || raw.includes('%')) return false;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return false;
  return raw.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg === seg.trim());
}

/** Validate and NFC-normalise a vault-relative Markdown path; `null` when unsafe or out of scope. */
export function parseVaultPath(raw: string): VaultPath | null {
  if (!isStructurallySafePath(raw)) return null;
  const path = raw.normalize('NFC');
  if (!isStructurallySafePath(path)) return null;
  if (DENIED_ROOTS.has(path.split('/')[0]!)) return null;
  if (!path.endsWith('.md')) return null;
  return path as VaultPath;
}

export function canWrite(path: VaultPath, kind: 'create' | 'update'): boolean {
  if (path === TODO_LIST_PATH) return kind === 'update';
  const segments = path.split('/');
  return kind === 'create' && segments.length === 2 && segments[0] === INBOX_DIR;
}

/**
 * Allowlisted root, and no hidden or denied folder at any depth (P4-A stricter reading of the §1 "Never" row:
 * `Projects/.obsidian/x.md` or `Projects/tmp/x.md` are as off-limits as the roots of the same name).
 */
export function canReadLinkedNote(path: VaultPath): boolean {
  const segments = path.split('/');
  if (!LINKED_NOTE_ALLOWED_ROOTS.has(segments[0]!)) return false;
  return segments.slice(1, -1).every((s) => !s.startsWith('.') && !DENIED_ROOTS.has(s)) && !segments.at(-1)!.startsWith('.');
}

export const LINKED_NOTE_ROOTS: readonly string[] = [...LINKED_NOTE_ALLOWED_ROOTS];
