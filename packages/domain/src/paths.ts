// Path policy: docs/vault-contract.md §1. Every path passes here before an adapter sees it.
import { SCOUT_STATUS_DIR, TRAINING_PATH } from '@vault-companion/contracts';
import type { VaultPath } from './store.ts';

export const TODO_LIST_PATH = 'Tasks/To-Do List.md';
export const INBOX_DIR = 'Inbox';
/** ADR-0029 write targets of the daily research explainer. */
export const EXPLAINED_DIR = 'Research/Explained';
export const EXPLAINER_STATUS_PATH = `${SCOUT_STATUS_DIR}/research-explainer.json`;

const DENIED_ROOTS = new Set(['.git', '.obsidian', '.trash', 'Tools', 'tmp', 'output']);
// Case-folded: the owner's desktop (Windows) treats `TMP/` and `tmp/` as the same folder.
const DENIED_FOLDED = new Set([...DENIED_ROOTS].map((r) => r.toLowerCase()));
const isDenied = (segment: string): boolean => DENIED_FOLDED.has(segment.toLowerCase());
export const isTriageDecisionPath = (path: string): boolean => /^Events\/Triage\/Decisions\/\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(path);
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

/** Validate and NFC-normalise a note or read-only scout status path. */
export function parseVaultPath(raw: string): VaultPath | null {
  if (!isStructurallySafePath(raw)) return null;
  const path = raw.normalize('NFC');
  if (!isStructurallySafePath(path)) return null;
  if (isDenied(path.split('/')[0]!)) return null;
  const scoutStatus = path.startsWith(`${SCOUT_STATUS_DIR}/`) && path.split('/').length === 3 && path.endsWith('.json');
  const triage = path === 'Events/Triage/feed.json' || path === 'Events/Triage/applied.json' || isTriageDecisionPath(path);
  if (!path.endsWith('.md') && !scoutStatus && !triage) return null;
  return path as VaultPath;
}

/**
 * ADR-0022: a Markdown note directly in `Inbox/` (no subfolder), exactly as the path policy accepts it: structurally
 * safe, already NFC, not hidden. The only client-named path the app reads or updates, and only after it is listed.
 */
export function isInboxNotePath(raw: string): raw is VaultPath {
  const segments = raw.split('/');
  return segments.length === 2 && segments[0] === INBOX_DIR && parseVaultPath(raw) === raw && raw.endsWith('.md') &&
    !segments[1]!.startsWith('.');
}

/** ADR-0029: a Markdown note directly in `Research/Explained/` (no subfolder, not hidden). */
export function isExplainedNotePath(path: string): boolean {
  const segments = path.split('/');
  return segments.length === 3 && `${segments[0]}/${segments[1]}` === EXPLAINED_DIR && parseVaultPath(path) === path &&
    path.endsWith('.md') && !segments[2]!.startsWith('.');
}

export function canWrite(path: VaultPath, kind: 'create' | 'update'): boolean {
  if (isTriageDecisionPath(path)) return true;
  if (path === EXPLAINER_STATUS_PATH) return true;
  // Create; update only replaces this job's own pending note (blob-SHA checked by the job, ADR-0029 amendment 2).
  if (isExplainedNotePath(path)) return true;
  if (path === TRAINING_PATH || path === TODO_LIST_PATH || path === 'Tasks/Active Work Now.md') return kind === 'update';
  if (kind === 'update') return isInboxNotePath(path);
  const segments = path.split('/');
  return segments.length === 2 && segments[0] === INBOX_DIR;
}

/**
 * Allowlisted root, and no hidden or denied folder at any depth: `Projects/.obsidian/x.md` or `Projects/tmp/x.md` are
 * as off-limits as the roots of the same name (vault-contract §1 "Never" row).
 */
export function canReadLinkedNote(path: VaultPath): boolean {
  const segments = path.split('/');
  if (!LINKED_NOTE_ALLOWED_ROOTS.has(segments[0]!)) return false;
  return segments.slice(1, -1).every((s) => !s.startsWith('.') && !isDenied(s)) && !segments.at(-1)!.startsWith('.');
}

export const LINKED_NOTE_ROOTS: readonly string[] = [...LINKED_NOTE_ALLOWED_ROOTS];

/** ADR-0020: any note folder, with the same hidden/denied segment policy as linked notes. */
export function canReadScoutOutput(raw: string): boolean {
  return isStructurallySafePath(raw) && raw.endsWith('.md') &&
    raw.split('/').every((s) => !s.startsWith('.') && !isDenied(s));
}
