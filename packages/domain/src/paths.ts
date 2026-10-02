// Path policy: docs/vault-contract.md §1. Every path passes here before an adapter sees it.
import { RADAR_APPLIED_PATH, RADAR_DECISIONS_DIR, SCOUT_STATUS_DIR, TRAINING_PATH } from '@vault-companion/contracts';
import type { VaultPath } from './store.ts';

export const TODO_LIST_PATH = 'Tasks/To-Do List.md';
export const INBOX_DIR = 'Inbox';
/** ADR-0029 write targets of the daily research explainer. */
export const EXPLAINED_DIR = 'Research/Explained';
export const EXPLAINER_STATUS_PATH = `${SCOUT_STATUS_DIR}/research-explainer.json`;
export const RADAR_DIR = 'Research/Radar';
export const RADAR_DECISIONS_DIR_LOCAL = RADAR_DECISIONS_DIR;
/** ADR-0036: the template a missing daily journal is rendered from (read-only). */
export const DAILY_JOURNAL_TEMPLATE_PATH = 'Templates/Daily Journal Template.md';
/** ADR-0040: the only note a feedback report may update; never created by the app. */
export const FEEDBACK_BACKLOG_PATH = 'Projects/Vault Companion/Vault Companion - Ready Backlog.md';

const DENIED_ROOTS = new Set(['.git', '.obsidian', '.trash', 'Tools', 'tmp', 'output']);
// Case-folded: the owner's desktop (Windows) treats `TMP/` and `tmp/` as the same folder.
const DENIED_FOLDED = new Set([...DENIED_ROOTS].map((r) => r.toLowerCase()));
const isDenied = (segment: string): boolean => DENIED_FOLDED.has(segment.toLowerCase());
export const isTriageDecisionPath = (path: string): boolean => /^Events\/Triage\/Decisions\/\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(path);
export const isRadarDecisionPath = (path: string): boolean => /^Research\/Radar\/Decisions\/\d{4}-(0[1-9]|1[0-2])\.jsonl$/.test(path);
export const isRadarAppliedPath = (path: string): boolean => path === RADAR_APPLIED_PATH;
const DAILY_JOURNAL_RE = /^Journal\/Daily\/\d{4}-\d{2}-\d{2}\.md$/;

function isValidDailyDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const midnight = `${date}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(midnight)) && new Date(midnight).toISOString().slice(0, 10) === date;
}

/** ADR-0036: `Journal/Daily/YYYY-MM-DD.md` for a valid calendar date; `null` for anything else. */
export function dailyJournalPath(date: string): VaultPath | null {
  if (!isValidDailyDate(date)) return null;
  return `Journal/Daily/${date}.md` as VaultPath;
}

/** ADR-0036: exactly a `Journal/Daily/` note for a valid calendar date — no traversal, no other folders. */
export function isDailyJournalPath(path: string): boolean {
  if (!DAILY_JOURNAL_RE.test(path) || !isStructurallySafePath(path)) return false;
  return isValidDailyDate(path.slice('Journal/Daily/'.length, -'.md'.length));
}
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
  const radar = isRadarDecisionPath(path) || isRadarAppliedPath(path);
  if (!path.endsWith('.md') && !scoutStatus && !triage && !radar) return null;
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
  if (path === FEEDBACK_BACKLOG_PATH) return kind === 'update';
  if (isTriageDecisionPath(path)) return true;
  if (isRadarDecisionPath(path)) return true;
  if (path === EXPLAINER_STATUS_PATH) return true;
  // Create; update only replaces this job's own pending note (blob-SHA checked by the job, ADR-0029 amendment 2).
  if (isExplainedNotePath(path)) return true;
  if (isDailyJournalPath(path)) return true;
  if (path === TRAINING_PATH || path === TODO_LIST_PATH || path === 'Tasks/Active Work Now.md') return kind === 'update';
  if (kind === 'update') return isInboxNotePath(path);
  const segments = path.split('/');
  return segments.length === 2 && segments[0] === INBOX_DIR;
}

/**
 * ADR-0032 read allowlist: exactly the four research source note folders (direct `.md` files only), the monthly
 * decision JSONL, and `Radar/applied.json`. Never a client-named path; only listing output is read.
 */
const RADAR_NOTE_DIRS = new Set(['Research/Daily Research Scout', 'Research/Reading Briefs', 'Research/Important Research Updates', 'Research/Explained']);
export function canReadRadarSource(raw: string): boolean {
  if (!isStructurallySafePath(raw)) return false;
  if (isRadarDecisionPath(raw) || isRadarAppliedPath(raw)) return true;
  const segments = raw.split('/');
  if (segments.length !== 3 || !raw.endsWith('.md')) return false;
  const dir = `${segments[0]}/${segments[1]}`;
  return RADAR_NOTE_DIRS.has(dir) && !segments[2]!.startsWith('.') && !isDenied(segments[2]!);
}

/** ADR-0032: applied library paths are only valid under `Research/Library/` (direct or nested), no hidden/denied parts. */
export function isResearchLibraryPath(raw: string): boolean {
  if (!isStructurallySafePath(raw) || !raw.startsWith('Research/Library/') || !raw.endsWith('.md')) return false;
  const segments = raw.split('/');
  return segments.length >= 3 && segments.slice(1).every((s) => !s.startsWith('.') && !isDenied(s));
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
