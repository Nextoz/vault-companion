// Path policy: docs/vault-contract.md §1. Every path passes here before an adapter sees it.
import type { VaultPath } from './store.ts';

export const TODO_LIST_PATH = 'Tasks/To-Do List.md';
export const INBOX_DIR = 'Inbox';

const DENIED_ROOTS = new Set(['.git', '.obsidian', '.trash', 'Tools', 'tmp', 'output']);
const LINKED_NOTE_DENIED_ROOTS = new Set(['Journal', 'Health']);

/** Validate and NFC-normalise a vault-relative Markdown path; `null` when unsafe or out of scope. */
export function parseVaultPath(raw: string): VaultPath | null {
  if (raw.length === 0 || raw.length > 512) return null;
  // Control characters, backslashes and percent-encoding never appear in legitimate vault paths.
  if (/[\u0000-\u001f\u007f\\%]/.test(raw)) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  const path = raw.normalize('NFC');
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment !== segment.trim()) return null;
  }
  if (DENIED_ROOTS.has(segments[0]!)) return null;
  if (!path.endsWith('.md')) return null;
  return path as VaultPath;
}

export function canWrite(path: VaultPath, kind: 'create' | 'update'): boolean {
  if (path === TODO_LIST_PATH) return kind === 'update';
  const segments = path.split('/');
  return kind === 'create' && segments.length === 2 && segments[0] === INBOX_DIR;
}

export function canReadLinkedNote(path: VaultPath): boolean {
  return !LINKED_NOTE_DENIED_ROOTS.has(path.split('/')[0]!);
}
