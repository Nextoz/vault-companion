// Research Radar read model (ADR-0032): parse the three research source folders plus explanations, merge papers by
// canonical URL, rank deterministically, and replay remove/keep/undo decisions. Pure domain code (AGENTS rule 5).
import {
  MAX_NOTE_BYTES,
  RADAR_APPLIED_PATH,
  RADAR_DECISIONS_DIR,
  RadarPaperId,
  type ApiError,
  type RadarDecisionLine,
  type RadarNoteResponse,
  type RadarNoteRefusalCode,
  type RadarPaper,
  type RadarReadTarget,
  type RadarResponse,
} from '@vault-companion/contracts';
import { canReadRadarSource, isResearchLibraryPath, parseVaultPath } from './paths.ts';
import {
  canonicalRadarUrl,
  effectiveRadarDecisions,
  MAX_RADAR_DECISION_MONTHS,
  parseRadarApplied,
  parseRadarDecisionLines,
  radarDecisionMonths,
  radarPaperId,
  RadarAppliedUnreadableError,
  RadarDecisionUnreadableError,
  validateRadarDecisionMonths,
  type RadarDecisionMonth,
} from './research-radar-format.ts';
import { FileTooLarge, StoreUnavailable, StoreUnknownOutcome, type ListedFile, type VaultStore } from './store.ts';
import { DEFAULT_USER_TIME_ZONE, userDate } from './time.ts';

export const RADAR_SCOUT_NOTE_DIR = 'Research/Daily Research Scout';
export const RADAR_BRIEF_DIR = 'Research/Reading Briefs';
export const IMPORTANT_DIR = 'Research/Important Research Updates';
export const RADAR_EXPLAINED_DIR = 'Research/Explained';

export const RADAR_DAYS = 7;

export const radarScoutNotePath = (date: string): string => `${RADAR_SCOUT_NOTE_DIR}/Daily Research Scout - ${date}.md`;
export const radarBriefPath = (date: string): string => `${RADAR_BRIEF_DIR}/Research Reading Brief - ${date}.md`;
export function radarDecisionPath(at: string | Date, timeZone = 'Europe/Copenhagen'): string {
  return `${RADAR_DECISIONS_DIR}/${userDate(at, timeZone).slice(0, 7)}.jsonl`;
}

const daysBefore = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const sevenDays = (today: string): string[] => Array.from({ length: RADAR_DAYS }, (_, i) => daysBefore(today, i));

// ---- frontmatter ----

export interface RadarFrontmatter {
  title: string | null;
  created: string | null;
  status: string | null;
  source: string | null;
  scoutHealth: string | null;
  confidence: number | null;
  tags: string[];
}

function yamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value === 'null') return null;
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

export function parseRadarFrontmatter(markdown: string): RadarFrontmatter {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return { title: null, created: null, status: null, source: null, scoutHealth: null, confidence: null, tags: [] };
  const out: RadarFrontmatter = { title: null, created: null, status: null, source: null, scoutHealth: null, confidence: null, tags: [] };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === '---') break;
    const tag = /^ {2,}-\s+(.+?)\s*$/.exec(line);
    if (tag) {
      out.tags = [...out.tags, tag[1]!];
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2]!;
    if (key === 'tags') {
      if (raw.startsWith('[')) {
        const inner = raw.replace(/^\[|\]$/g, '');
        out.tags = inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
      continue;
    }
    const value = yamlScalar(raw);
    if (key === 'title') out.title = value;
    else if (key === 'created') out.created = value;
    else if (key === 'status') out.status = value;
    else if (key === 'source') out.source = value;
    else if (key === 'scout_health') out.scoutHealth = value;
    else if (key === 'confidence') {
      const n = value === null ? NaN : Number(value);
      out.confidence = Number.isFinite(n) ? n : null;
    }
  }
  return out;
}

const RADAR_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Keep one malformed displayed string from invalidating the whole Radar wire schema. */
function sanitizeRadarText(raw: string, fallback: string, max: number): string {
  const cleaned = raw.replace(RADAR_TEXT_CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return cleaned === '' ? fallback.slice(0, max) : cleaned;
}

const GENERIC_RADAR_TAGS = new Set([
  'ai', 'research', 'daily-scout', 'research-update', 'source-verified', 'reading-queue', 'research-updated',
]);

/** Topic = the last non-generic frontmatter tag; `untagged` when the note has none. */
export function radarTopic(fm: RadarFrontmatter): string {
  for (let i = fm.tags.length - 1; i >= 0; i--) {
    const tag = sanitizeRadarText(fm.tags[i]!, '', 100);
    if (tag && !GENERIC_RADAR_TAGS.has(tag.toLowerCase())) return tag;
  }
  return 'untagged';
}

// ---- sections and list items ----

function visibleBullets(markdown: string, heading: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inSection = false;
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const run = f[1]!;
      if (!fence) { fence = { ch: run[0]!, len: run.length }; continue; }
      if (run[0] === fence.ch && run.length >= fence.len && f[2]!.trim() === '') { fence = null; continue; }
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1]!.length <= 2) inSection = h[1]!.length === 2 && h[2]!.toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) out.push(item[1]!);
  }
  return out;
}

function firstParagraph(markdown: string, heading: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inSection = false;
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const run = f[1]!;
      if (!fence) { fence = { ch: run[0]!, len: run.length }; continue; }
      if (run[0] === fence.ch && run.length >= fence.len && f[2]!.trim() === '') { fence = null; continue; }
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1]!.length <= 2) inSection = h[1]!.length === 2 && h[2]!.toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (inSection && line.trim() !== '' && !/^(?:[-*+]|\d+[.)])\s+/.test(line)) return line.trim();
  }
  return '';
}

const URL_RE = /https?:\/\/[^\s<>)\]]+/;

function cleanItemUrl(raw: string): string | null {
  const url = raw.replace(/[.,;:!?]+$/, '');
  if (url.length > 500 || /[\s"'<>`\\]/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const stripScore = (text: string): string => text.replace(/\s*\d{1,3}(?:\.\d+)?\s*\/\s*100\s*$/, '').trim();
const scoreOf = (text: string): number | null => {
  const m = /(\d{1,3}(?:\.\d+)?)\s*\/\s*100/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

function plainItemText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–:|-]+|[\s—–:|-]+$/g, '')
    .trim();
}

export interface RadarItem {
  readonly url: string;
  readonly title: string;
  readonly why: string;
  readonly score: number | null;
}

/**
 * Parses Scout `Most relevant items` triplets (`title`, `url`, `why … score/100`) and Brief `Read today` items, which
 * may be inline Markdown links. Consecutive top-level bullets are grouped around the bullet that carries the URL.
 */
export function parseRadarItems(markdown: string, heading: string): RadarItem[] {
  const bullets = visibleBullets(markdown, heading);
  const out: RadarItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i]!;
    const md = /\[([^\]]*)\]\((\S+?)\)/.exec(bullet);
    const bare = md ? null : URL_RE.exec(bullet);
    const url = md ? cleanItemUrl(md[2]!) : bare ? cleanItemUrl(bare[0]!) : null;
    if (!url || seen.has(url)) continue;
    const previous = i > 0 ? bullets[i - 1]! : null;
    const next = i + 1 < bullets.length ? bullets[i + 1]! : null;
    const title = md
      ? plainItemText(md[1]!) || (previous && !URL_RE.test(previous) ? plainItemText(previous) : url)
      : previous && !URL_RE.test(previous) ? plainItemText(previous) : url;
    let why = md ? bullet.replace(md[0], ' ') : bullet.replace(bare![0], ' ');
    if (next && !URL_RE.test(next)) why += ` ${next}`;
    why = stripScore(plainItemText(why)).slice(0, 500);
    const score = scoreOf(bullet) ?? (next ? scoreOf(next) : null);
    out.push({ url, title: title.slice(0, 500), why, score });
    seen.add(url);
  }
  return out;
}

export function parseRadarWhy(markdown: string): string {
  const bullets = visibleBullets(markdown, 'Curation decision');
  if (bullets[0]) return plainItemText(bullets[0]!).slice(0, 500);
  return firstParagraph(markdown, 'Short answer').slice(0, 500);
}

// ---- candidates, merge, rank, topics ----

export type RadarIntakeKind = 'important' | 'brief' | 'scout';

export interface RadarCandidate {
  readonly paperId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly why: string;
  readonly topic: string;
  readonly sourceDate: string;
  readonly priority: number;
  readonly score: number;
  readonly intake: RadarIntakeKind;
  readonly notePath: string | null;
}

export function mergeRadarCandidates(items: readonly RadarCandidate[]): RadarCandidate[] {
  const byId = new Map<string, RadarCandidate>();
  const tie = (item: RadarCandidate) => `${canonicalRadarUrl(item.sourceUrl) ?? item.sourceUrl}\u0000${item.title}\u0000${item.notePath ?? ''}`;
  for (const item of items) {
    const existing = byId.get(item.paperId);
    const better = !existing ||
      item.priority > existing.priority ||
      (item.priority === existing.priority && item.score > existing.score) ||
      (item.priority === existing.priority && item.score === existing.score && tie(item) < tie(existing));
    if (better) {
      byId.set(item.paperId, item);
    }
  }
  return [...byId.values()];
}

export function rankRadarCandidates(items: readonly RadarCandidate[]): RadarCandidate[] {
  const canonical = (item: RadarCandidate) => canonicalRadarUrl(item.sourceUrl) ?? item.sourceUrl;
  return [...items].sort((a, b) =>
    b.priority - a.priority ||
    b.score - a.score ||
    (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
}

export function radarTopics(items: readonly RadarCandidate[]): { topic: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.topic, (counts.get(item.topic) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20)
    .map(([topic, count]) => ({ topic, count }));
}

export function radarReadTarget(item: RadarCandidate, explanationPath: string | null): RadarReadTarget {
  if (explanationPath) return { kind: 'explanation', path: explanationPath };
  if (item.intake === 'important' && item.notePath) return { kind: 'note', path: item.notePath };
  if (item.notePath) return { kind: 'note', path: item.notePath };
  return { kind: 'source', url: item.sourceUrl };
}

// ---- read service ----

export interface ResearchRadarServiceDeps {
  readonly store: VaultStore;
  readonly now: () => Date;
  readonly timeZone: string;
}

interface ReadNote {
  readonly path: string;
  readonly blobSha: string;
  readonly markdown: string;
}

async function readAllowedNote(store: VaultStore, x: string, listed: ListedFile): Promise<ReadNote | null> {
  const path = parseVaultPath(listed.path);
  if (!path || !canReadRadarSource(path)) return null;
  let file;
  try {
    file = await store.readFile(path, x);
  } catch (e) {
    // An oversized source note is an unreadable note, not a whole-Radar outage (review 7 finding 4).
    if (e instanceof FileTooLarge) return null;
    throw e;
  }
  if (!file || file.blobSha !== listed.blobSha || file.bytes.length > MAX_NOTE_BYTES) return null;
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    return null;
  }
  return { path: listed.path, blobSha: file.blobSha, markdown };
}

export interface RadarDecisionHistory {
  /** Months that actually contain a listed decision log, in oldest-first append order. */
  readonly months: readonly RadarDecisionMonth[];
  /** Validated decision lines in authoritative append order. */
  readonly lines: RadarDecisionLine[];
  /** Decision text per generated month; null when that month has no listed log. */
  readonly textByMonth: ReadonlyMap<string, string | null>;
}

const RADAR_DECISION_FILE = /^(\d{4}-(0[1-9]|1[0-2]))\.jsonl$/;
const MALFORMED_RADAR_DECISION_FILE = /^(\d{4}-\d{2})\.jsonl$/;

async function readListedDecisionText(store: VaultStore, x: string, listed: ListedFile): Promise<string> {
  const path = parseVaultPath(listed.path);
  if (!path) throw new RadarDecisionUnreadableError('unsupported-line', 'invalid Radar decision path');
  let file;
  try {
    file = await store.readFile(path, x);
  } catch (e) {
    if (e instanceof FileTooLarge) throw new RadarDecisionUnreadableError('too-large', 'a Radar decision log is larger than 1 MB');
    throw e;
  }
  if (!file) throw new RadarDecisionUnreadableError('missing-at-revision', 'a listed Radar decision log is missing at the pinned revision');
  if (file.blobSha !== listed.blobSha) throw new RadarDecisionUnreadableError('blob-mismatch', 'a listed Radar decision log changed during the read');
  if (file.bytes.length > MAX_NOTE_BYTES) throw new RadarDecisionUnreadableError('too-large', 'a Radar decision log is larger than 1 MB');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    throw new RadarDecisionUnreadableError('encoding', 'a Radar decision log is not valid UTF-8');
  }
}

/**
 * Reads and validates the bounded monthly decision window at one pinned commit. A listed-but-missing/mismatched
 * log, invalid UTF-8, malformed JSONL, duplicate/foreign Undo, or a window wider than the bound is an unreadable
 * state — never an invented absence.
 */
export async function readRadarDecisionHistory(
  store: VaultStore,
  x: string,
  files: readonly ListedFile[],
  currentMonth: string,
): Promise<RadarDecisionHistory> {
  const window = radarDecisionMonths(currentMonth, MAX_RADAR_DECISION_MONTHS);
  const inWindow = new Set(window);
  const byMonth = new Map<string, ListedFile>();
  for (const file of files) {
    const name = file.path.slice(RADAR_DECISIONS_DIR.length + 1);
    const match = RADAR_DECISION_FILE.exec(name);
    if (!match) {
      if (!name.includes('/') && MALFORMED_RADAR_DECISION_FILE.test(name)) {
        throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision history contains a malformed monthly log filename');
      }
      continue;
    }
    const month = match[1]!;
    if (!inWindow.has(month)) {
      if (month > currentMonth) {
        throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision history contains a future monthly log');
      }
      throw new RadarDecisionUnreadableError('too-much-history', 'Radar decision history spans more than 25 months');
    }
    byMonth.set(month, file);
  }

  const entries: RadarDecisionMonth[] = [];
  const textByMonth = new Map<string, string | null>();
  for (const month of window.slice().reverse()) {
    const listed = byMonth.get(month);
    if (!listed) {
      textByMonth.set(month, null);
      continue;
    }
    const text = await readListedDecisionText(store, x, listed);
    textByMonth.set(month, text);
    entries.push({ month, lines: parseRadarDecisionLines(text) });
  }

  const lines = validateRadarDecisionMonths(entries);
  if (lines.length > 5000) {
    throw new RadarDecisionUnreadableError('too-much-history', 'Radar decision history exceeds 5000 lines');
  }
  return { months: entries, lines, textByMonth };
}

type SourceState = RadarResponse['sources'][keyof RadarResponse['sources']];

function sourceState(found: number, usable: number, degraded = 0): SourceState {
  if (found === 0) return { state: 'absent', count: 0 };
  if (usable === 0 || degraded > 0) return { state: 'degraded', count: usable };
  return { state: 'ok', count: usable };
}

function scoutHealthDegraded(fm: RadarFrontmatter): boolean {
  return fm.scoutHealth !== 'ok' || fm.confidence === null || fm.confidence < 0 || fm.confidence > 1;
}

function direct(files: readonly ListedFile[], dir: string): ListedFile[] {
  return files.filter((f) => f.path.startsWith(`${dir}/`) && f.path.slice(dir.length + 1).indexOf('/') === -1 && f.path.endsWith('.md'));
}

/**
 * Aggregate intake-note reads per Radar request (scout + brief + important + explained). Together with head, five
 * directory listings, up to 25 monthly decision logs and `applied.json`, this keeps one read at ≤ 48 GitHub
 * subrequests, leaving headroom for the inherited Access/token request (review 7 finding 5).
 */
export const RADAR_NOTE_READ_BUDGET = 16;

const RADAR_READ_RESERVES = { important: 5, scout: 4, brief: 4, explained: 3 } as const;

interface ReadNotesOutcome {
  readonly notes: ReadNote[];
  /** Files that were attempted but could not be read (encoding, size guard, missing/mismatched blob). */
  readonly unreadable: number;
  /** Files never attempted because the aggregate note budget was exhausted. */
  readonly capped: number;
}

interface ReadNoteSlice {
  readonly notes: ReadNote[];
  readonly unreadable: number;
  readonly attempted: number;
  readonly remaining: ListedFile[];
}

const byPath = (a: ListedFile, b: ListedFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function importantDateHint(file: ListedFile): string | null {
  const name = file.path.slice(IMPORTANT_DIR.length + 1);
  return /^(\d{4}-\d{2}-\d{2})\b/.exec(name)?.[1] ?? null;
}

function pathHash(path: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Filename dates are only preselection hints: parsed `created`, `status`, and `source` remain authoritative for
 * Important eligibility. Current Copenhagen seven-day date-prefixed files come first, then newer dated hints, then a
 * deterministic day-rotated undated fallback so unknown filenames are still considered rather than silently dropped.
 */
function importantOrder(window: ReadonlySet<string>, today: string): (a: ListedFile, b: ListedFile) => number {
  const rank = (file: ListedFile): number => {
    const hint = importantDateHint(file);
    if (hint === null) return 2;
    return window.has(hint) ? 0 : 1;
  };
  const day = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000);
  return (a, b) => {
    const ar = rank(a);
    const br = rank(b);
    if (ar !== br) return ar - br;
    const ah = importantDateHint(a);
    const bh = importantDateHint(b);
    if (ah !== null && bh !== null && ah !== bh) return ah < bh ? 1 : -1;
    if (ah !== null && bh === null) return -1;
    if (ah === null && bh !== null) return 1;
    if (ah !== null && bh !== null) return byPath(a, b);
    const ha = pathHash(a.path, day);
    const hb = pathHash(b.path, day);
    return ha === hb ? byPath(a, b) : ha < hb ? -1 : 1;
  };
}

interface CandidateHint {
  readonly title: string;
  readonly sourceUrl: string;
}

function candidateHints(
  scoutNotes: readonly ReadNote[],
  briefNotes: readonly ReadNote[],
  importantNotes: readonly ReadNote[],
): CandidateHint[] {
  const hints: CandidateHint[] = [];
  for (const note of scoutNotes) {
    for (const item of parseRadarItems(note.markdown, 'Most relevant items')) hints.push({ title: item.title, sourceUrl: item.url });
  }
  for (const note of briefNotes) {
    for (const item of [...parseRadarItems(note.markdown, 'Read today'), ...parseRadarItems(note.markdown, 'Read this week')]) {
      hints.push({ title: item.title, sourceUrl: item.url });
    }
  }
  for (const note of importantNotes) {
    const fm = parseRadarFrontmatter(note.markdown);
    if (fm.source) hints.push({ title: fm.title ?? '', sourceUrl: fm.source });
  }
  return hints;
}

function normalizeHint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Preselection for explanation notes only. Matching a ranked candidate title/source path is a read-order hint; the
 * actual explanation association is still made from the parsed canonical source URL, never from a guessed title.
 */
function explanationOrder(candidates: readonly CandidateHint[]): (a: ListedFile, b: ListedFile) => number {
  const titles = candidates.map((c) => normalizeHint(c.title)).filter((t) => t.length >= 3);
  const sourceFragments = candidates.map((c) => {
    try {
      const pathname = new URL(c.sourceUrl).pathname;
      return normalizeHint(pathname.split('/').filter(Boolean).at(-1) ?? '');
    } catch {
      return '';
    }
  }).filter((t) => t.length >= 3);
  return (a, b) => {
    const score = (file: ListedFile): number => {
      const stem = normalizeHint(file.path.slice(RADAR_EXPLAINED_DIR.length + 1).replace(/\.md$/i, ''));
      if (!stem) return 2;
      if (titles.some((title) => stem.includes(title) || title.includes(stem))) return 0;
      if (sourceFragments.some((fragment) => stem.includes(fragment) || fragment.includes(stem))) return 1;
      return 2;
    };
    const sa = score(a);
    const sb = score(b);
    return sa === sb ? byPath(a, b) : sa - sb;
  };
}

/** Reads the first `limit` files in the supplied deterministic order, leaving later files for the spare pass. */
async function readNoteSlice(
  store: VaultStore,
  x: string,
  files: readonly ListedFile[],
  budget: { remaining: number },
  limit: number,
  order: (a: ListedFile, b: ListedFile) => number,
): Promise<ReadNoteSlice> {
  const sorted = [...files].sort(order);
  const notes: ReadNote[] = [];
  let unreadable = 0;
  let attempted = 0;
  const remaining: ListedFile[] = [];
  for (const listed of sorted) {
    if (attempted >= limit || budget.remaining <= 0) {
      remaining.push(listed);
      continue;
    }
    budget.remaining -= 1;
    attempted += 1;
    const note = await readAllowedNote(store, x, listed);
    if (note) notes.push(note);
    else unreadable += 1;
  }
  return { notes, unreadable, attempted, remaining };
}

function finishRead(reserved: ReadNoteSlice, spare: ReadNoteSlice): ReadNotesOutcome {
  return {
    notes: [...reserved.notes, ...spare.notes],
    unreadable: reserved.unreadable + spare.unreadable,
    capped: spare.remaining.length,
  };
}

interface ResearchRadarRead {
  readonly response: RadarResponse;
  /** Every allowlisted note read for the response, by path, so a note open never re-reads or re-builds. */
  readonly notesByPath: ReadonlyMap<string, ReadNote>;
}

async function loadResearchRadar(deps: ResearchRadarServiceDeps): Promise<ResearchRadarRead> {
  const now = deps.now();
  const date = userDate(now, DEFAULT_USER_TIME_ZONE);
  const window = new Set(sevenDays(date));
  const { commitSha: x } = await deps.store.head();

  const [scoutFiles, briefFiles, importantFiles, explainedFiles, radarFiles] = await Promise.all([
    deps.store.listFiles(RADAR_SCOUT_NOTE_DIR, x),
    deps.store.listFiles(RADAR_BRIEF_DIR, x),
    deps.store.listFiles(IMPORTANT_DIR, x),
    deps.store.listFiles(RADAR_EXPLAINED_DIR, x),
    deps.store.listFiles(RADAR_DECISIONS_DIR, x),
  ]);

  const scoutListed = direct(scoutFiles, RADAR_SCOUT_NOTE_DIR).filter((f) => {
    const m = /^Daily Research Scout - (\d{4}-\d{2}-\d{2})\.md$/.exec(f.path.slice(RADAR_SCOUT_NOTE_DIR.length + 1));
    return m ? window.has(m[1]!) : false;
  });
  const briefListed = direct(briefFiles, RADAR_BRIEF_DIR).filter((f) => {
    const m = /^Research Reading Brief - (\d{4}-\d{2}-\d{2})\.md$/.exec(f.path.slice(RADAR_BRIEF_DIR.length + 1));
    return m ? window.has(m[1]!) : false;
  });
  const importantListed = direct(importantFiles, IMPORTANT_DIR);
  const explainedListed = direct(explainedFiles, RADAR_EXPLAINED_DIR);

  const budget = { remaining: RADAR_NOTE_READ_BUDGET };
  const importantCompare = importantOrder(window, date);
  const scoutReserved = await readNoteSlice(deps.store, x, scoutListed, budget, RADAR_READ_RESERVES.scout, byPath);
  const briefReserved = await readNoteSlice(deps.store, x, briefListed, budget, RADAR_READ_RESERVES.brief, byPath);
  const importantReserved = await readNoteSlice(deps.store, x, importantListed, budget, RADAR_READ_RESERVES.important, importantCompare);
  const explainedReserved = await readNoteSlice(
    deps.store,
    x,
    explainedListed,
    budget,
    RADAR_READ_RESERVES.explained,
    explanationOrder(candidateHints(scoutReserved.notes, briefReserved.notes, importantReserved.notes)),
  );
  const scoutSpare = await readNoteSlice(deps.store, x, scoutReserved.remaining, budget, Number.POSITIVE_INFINITY, byPath);
  const briefSpare = await readNoteSlice(deps.store, x, briefReserved.remaining, budget, Number.POSITIVE_INFINITY, byPath);
  const importantSpare = await readNoteSlice(deps.store, x, importantReserved.remaining, budget, Number.POSITIVE_INFINITY, importantCompare);
  const explainedSpare = await readNoteSlice(
    deps.store,
    x,
    explainedReserved.remaining,
    budget,
    Number.POSITIVE_INFINITY,
    explanationOrder(candidateHints(scoutReserved.notes, briefReserved.notes, importantReserved.notes)),
  );
  const scoutRead = finishRead(scoutReserved, scoutSpare);
  const briefRead = finishRead(briefReserved, briefSpare);
  const importantRead = finishRead(importantReserved, importantSpare);
  const explainedRead = finishRead(explainedReserved, explainedSpare);
  const scoutNotes = scoutRead.notes;
  const briefNotes = briefRead.notes;
  const importantNotes = importantRead.notes;
  const explainedNotes = explainedRead.notes;
  const notesByPath = new Map<string, ReadNote>();
  for (const note of [...scoutNotes, ...briefNotes, ...importantNotes, ...explainedNotes]) notesByPath.set(note.path, note);
  const scoutUnreadable = scoutRead.unreadable + scoutRead.capped;
  const briefUnreadable = briefRead.unreadable + briefRead.capped;
  const importantUnreadable = importantRead.unreadable + importantRead.capped;
  const explainedUnreadable = explainedRead.unreadable + explainedRead.capped;
  const scoutDegraded = scoutUnreadable + scoutNotes.filter((note) => scoutHealthDegraded(parseRadarFrontmatter(note.markdown))).length;

  const candidates: RadarCandidate[] = [];
  const warnings: string[] = [];

  const explanationByPaper = new Map<string, string>();
  for (const note of explainedNotes) {
    const fm = parseRadarFrontmatter(note.markdown);
    if (!fm.source) continue;
    const id = await radarPaperId(fm.source);
    if (id) explanationByPaper.set(id, note.path);
  }

  for (const note of scoutNotes) {
    const fm = parseRadarFrontmatter(note.markdown);
    const topic = radarTopic(fm);
    const m = /^Daily Research Scout - (\d{4}-\d{2}-\d{2})\.md$/.exec(note.path.slice(RADAR_SCOUT_NOTE_DIR.length + 1));
    if (!m) continue;
    const items = parseRadarItems(note.markdown, 'Most relevant items');
    for (const item of items) {
      const id = await radarPaperId(item.url);
      if (!id) continue;
      candidates.push({
        paperId: id, sourceUrl: item.url, title: sanitizeRadarText(item.title, id, 500), why: sanitizeRadarText(item.why, '', 500),
        topic: sanitizeRadarText(topic, 'untagged', 100), sourceDate: m[1]!, priority: 1,
        score: item.score ?? 0, intake: 'scout', notePath: note.path,
      });
    }
  }

  for (const note of briefNotes) {
    const fm = parseRadarFrontmatter(note.markdown);
    const topic = radarTopic(fm);
    const m = /^Research Reading Brief - (\d{4}-\d{2}-\d{2})\.md$/.exec(note.path.slice(RADAR_BRIEF_DIR.length + 1));
    if (!m) continue;
    const items = [...parseRadarItems(note.markdown, 'Read today'), ...parseRadarItems(note.markdown, 'Read this week')];
    for (const item of items) {
      const id = await radarPaperId(item.url);
      if (!id) continue;
      candidates.push({
        paperId: id, sourceUrl: item.url, title: sanitizeRadarText(item.title, id, 500), why: sanitizeRadarText(item.why, '', 500),
        topic: sanitizeRadarText(topic, 'untagged', 100), sourceDate: m[1]!, priority: 2,
        score: item.score ?? 0, intake: 'brief', notePath: note.path,
      });
    }
  }

  for (const note of importantNotes) {
    const fm = parseRadarFrontmatter(note.markdown);
    if (fm.status !== 'active') continue;
    if (!fm.created || !window.has(fm.created) || !fm.source) continue;
    const id = await radarPaperId(fm.source);
    if (!id) continue;
    const title = fm.title ?? /^#\s+(.+)$/m.exec(note.markdown.replace(/\r\n?/g, '\n'))?.[1]?.trim() ?? id;
    candidates.push({
      paperId: id, sourceUrl: fm.source, title: sanitizeRadarText(title, id, 500), why: sanitizeRadarText(parseRadarWhy(note.markdown), '', 500),
      topic: sanitizeRadarText(radarTopic(fm), 'untagged', 100),
      sourceDate: fm.created, priority: 3, score: 0, intake: 'important', notePath: note.path,
    });
  }

  const currentMonth = userDate(now, DEFAULT_USER_TIME_ZONE).slice(0, 7);
  const decisionHistory = await readRadarDecisionHistory(deps.store, x, radarFiles, currentMonth);
  const monthByDecisionId = new Map<string, string>();
  for (const entry of decisionHistory.months) {
    for (const line of entry.lines) monthByDecisionId.set(line.decisionId, entry.month);
  }
  const decisions = decisionHistory.lines.map((line) => ({ ...line, month: monthByDecisionId.get(line.decisionId)! }));
  const state = effectiveRadarDecisions(decisions);

  const merged = mergeRadarCandidates(candidates);
  const eligible = rankRadarCandidates(merged).filter((item) => !state.removed.has(item.paperId) && !state.kept.has(item.paperId));
  const papers: RadarPaper[] = eligible.slice(0, 3).map((item, index) => {
    const explanationPath = explanationByPaper.get(item.paperId) ?? null;
    const badges: RadarPaper['badges'] = [];
    if (item.intake === 'important') badges.push('important');
    if (explanationPath) badges.push('explained');
    return {
      paperId: item.paperId,
      rank: index + 1,
      title: item.title,
      why: item.why,
      topic: item.topic,
      sourceUrl: item.sourceUrl,
      sourceDate: item.sourceDate,
      badges,
      read: radarReadTarget(item, explanationPath),
    };
  });

  let appliedFile;
  try {
    appliedFile = await deps.store.readFile(parseVaultPath(RADAR_APPLIED_PATH)!, x);
  } catch (e) {
    if (e instanceof FileTooLarge) throw new RadarAppliedUnreadableError('Research Radar applied state is larger than 1 MB');
    throw e;
  }
  let appliedText: string | null;
  try {
    appliedText = appliedFile ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(appliedFile.bytes) : null;
  } catch {
    throw new RadarAppliedUnreadableError('Research Radar applied state is not valid UTF-8');
  }
  const parsedApplied = parseRadarApplied(appliedText);

  const topics = radarTopics(eligible);

  const sources: RadarResponse['sources'] = {
    dailyScout: sourceState(scoutListed.length, candidates.filter((c) => c.intake === 'scout').length, scoutDegraded),
    readingBriefs: sourceState(briefListed.length, candidates.filter((c) => c.intake === 'brief').length, briefUnreadable),
    importantUpdates: sourceState(importantListed.length, candidates.filter((c) => c.intake === 'important').length, importantUnreadable),
    explained: sourceState(explainedListed.length, explanationByPaper.size, explainedUnreadable),
  };
  const sourceReads = {
    dailyScout: scoutRead,
    readingBriefs: briefRead,
    importantUpdates: importantRead,
    explained: explainedRead,
  } as const;
  for (const [name, value] of Object.entries(sources)) {
    const windowed = name === 'dailyScout' || name === 'readingBriefs';
    const notesPhrase = windowed ? 'notes in the last seven days' : 'notes';
    const noun = name === 'explained' ? { singular: 'explanation', plural: 'explanations' } : { singular: 'paper', plural: 'papers' };
    const read = sourceReads[name as keyof typeof sourceReads];
    if (read.capped > 0) {
      const attempted = read.notes.length + read.unreadable;
      const total = attempted + read.capped;
      warnings.push(`${name} read only ${attempted} of ${total} ${noun.plural} before the read budget; partial coverage.`);
    } else if (value.state === 'absent') warnings.push(`${name} has no readable ${notesPhrase}.`);
    else if (value.state === 'degraded' && value.count === 0) warnings.push(`${name} has ${notesPhrase}, but no ${noun.plural} could be read.`);
    else if (value.state === 'degraded') warnings.push(`${name} is degraded, so only ${value.count} ${value.count === 1 ? noun.singular : noun.plural} could be read.`);
  }

  const response: RadarResponse = {
    revision: x,
    now: now.toISOString(),
    sources,
    papers,
    topics,
    decisions,
    applied: parsedApplied.applied,
    appliedUpdatedAt: parsedApplied.appliedUpdatedAt,
    warnings,
  };
  return { response, notesByPath };
}

export async function buildResearchRadar(deps: ResearchRadarServiceDeps): Promise<RadarResponse> {
  return (await loadResearchRadar(deps)).response;
}

/**
 * RR3: read a desktop-owned Library note that `Radar/applied.json` recorded for a Keep decision. The path comes from
 * validated `applied.json` state (never client input) and is re-checked against the `Research/Library/` allowlist.
 */
async function readRadarLibraryNote(store: VaultStore, revision: string, rawPath: string): Promise<RadarNoteResponse> {
  const refused = (code: RadarNoteRefusalCode, message: string): RadarNoteResponse => ({ status: 'refused', revision, code, message });
  const path = parseVaultPath(rawPath);
  if (!path || !isResearchLibraryPath(path)) return refused('missing', 'this paper has no readable Library note');
  let file;
  try {
    file = await store.readFile(path, revision);
  } catch (e) {
    if (e instanceof FileTooLarge) return refused('too-large', 'the Library note is larger than 1 MB');
    throw e;
  }
  if (!file) return refused('missing', 'the Library note no longer exists at this revision');
  if (file.bytes.length > MAX_NOTE_BYTES) return refused('too-large', 'the Library note is larger than 1 MB');
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes);
  } catch {
    return refused('encoding', 'the Library note is not valid UTF-8');
  }
  return { status: 'ok', revision, path: rawPath, blobSha: file.blobSha, markdown };
}

export function createResearchRadarService(deps: ResearchRadarServiceDeps) {
  const readError = (message: string): ApiError => ({ code: 'upstream-unavailable', message, retryable: true });
  const refused = (revision: string, code: RadarNoteRefusalCode, message: string): RadarNoteResponse =>
    ({ status: 'refused', revision, code, message });
  return {
    async readResearchRadar(): Promise<RadarResponse | ApiError> {
      try {
        return (await loadResearchRadar(deps)).response;
      } catch (e) {
        if (e instanceof RadarAppliedUnreadableError) {
          return { code: 'invalid', message: 'Research Radar state is unreadable on this device', retryable: false };
        }
        if (e instanceof RadarDecisionUnreadableError) {
          return { code: 'invalid', message: 'Research Radar decision history is unreadable on this device', retryable: false };
        }
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return readError('Research Radar could not be read right now');
        }
        throw e;
      }
    },
    async readRadarNote(paperId: string): Promise<RadarNoteResponse | ApiError> {
      if (!RadarPaperId.safeParse(paperId).success) {
        return { code: 'invalid', message: 'invalid paper ID', retryable: false };
      }
      try {
        const { response, notesByPath } = await loadResearchRadar(deps);
        // RR3: a Keep that the desktop applied to a Library note wins over the intake/explanation note. Failed or
        // pending entries are not applied and fall through to the existing read resolution below.
        const keepDecisionId = effectiveRadarDecisions(response.decisions).keepDecisionByPaper.get(paperId);
        const appliedEntry = keepDecisionId ? response.applied[keepDecisionId] : undefined;
        if (appliedEntry?.status === 'applied' && appliedEntry.libraryPath !== null) {
          return await readRadarLibraryNote(deps.store, response.revision, appliedEntry.libraryPath);
        }
        const paper = response.papers.find((p) => p.paperId === paperId);
        if (!paper || (paper.read.kind !== 'note' && paper.read.kind !== 'explanation')) {
          return refused(response.revision, 'missing', 'this paper has no readable Radar note');
        }
        const path = parseVaultPath(paper.read.path);
        if (!path || !canReadRadarSource(path)) {
          return refused(response.revision, 'missing', 'this paper has no readable Radar note');
        }
        const note = notesByPath.get(paper.read.path);
        if (!note) return refused(response.revision, 'missing', 'the Radar note no longer exists at this revision');
        return { status: 'ok', revision: response.revision, path: paper.read.path, blobSha: note.blobSha, markdown: note.markdown };
      } catch (e) {
        if (e instanceof RadarAppliedUnreadableError) {
          return { code: 'invalid', message: 'Research Radar state is unreadable on this device', retryable: false };
        }
        if (e instanceof RadarDecisionUnreadableError) {
          return { code: 'invalid', message: 'Research Radar decision history is unreadable on this device', retryable: false };
        }
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome || e instanceof FileTooLarge) {
          return readError('Research Radar note could not be read right now');
        }
        throw e;
      }
    },
  };
}
