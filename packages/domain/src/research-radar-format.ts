// Pure Research Radar JSON/URL kernels (ADR-0032). No HTTP, React or GitHub code.
import { RadarAppliedEntry, RadarDecisionLine, effectiveRadarDecisions } from '@vault-companion/contracts';
import { isResearchLibraryPath } from './paths.ts';

export { effectiveRadarDecisions };
export type { RadarDecisionState } from '@vault-companion/contracts';

/** Bounded monthly decision window inspected by both the reader and writer. */
export const MAX_RADAR_DECISION_MONTHS = 25;
/** Bounded total decision-line count inspected by both the reader and writer. */
export const MAX_RADAR_DECISION_LINES = 5000;

export type RadarDecisionUnreadableReason =
  | 'invalid-jsonl'
  | 'unsupported-line'
  | 'duplicate-id'
  | 'invalid-undo'
  | 'missing-at-revision'
  | 'blob-mismatch'
  | 'too-large'
  | 'encoding'
  | 'too-much-history';

/** A Radar decision log could not be read faithfully; callers map this to an existing wire error. */
export class RadarDecisionUnreadableError extends Error {
  readonly reason: RadarDecisionUnreadableReason;

  constructor(reason: RadarDecisionUnreadableReason, message: string) {
    super(message);
    this.name = 'RadarDecisionUnreadableError';
    this.reason = reason;
  }
}

/** The immediately previous Copenhagen month (`YYYY-MM`). */
export function previousRadarMonth(month: string): string {
  const first = new Date(`${month}-01T12:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() - 1);
  return first.toISOString().slice(0, 7);
}

/** Current month first, then the bounded number of preceding months. */
export function radarDecisionMonths(currentMonth: string, count = MAX_RADAR_DECISION_MONTHS): string[] {
  const months: string[] = [];
  let month = currentMonth;
  for (let i = 0; i < count; i++) {
    months.push(month);
    month = previousRadarMonth(month);
  }
  return months;
}

/** Query parameters that identify tracking, not content, and are unambiguously safe to drop for identity. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid',
]);

/**
 * Canonical identity URL: http/https only, no userinfo/control characters, lower-case host preserved exactly (including
 * `www.`), fragment removed, and only the unambiguous tracking params above removed. Supported arXiv
 * `http(s)://arxiv.org` / `export.arxiv.org` `abs`/`pdf` forms are folded to one `https://arxiv.org/abs/<id>` URL;
 * other arXiv host/path shapes are refused rather than guessed. Anything unsupported returns null.
 */
export function canonicalRadarUrl(raw: string): string | null {
  const source = raw.trim();
  if (source.length > 2000 || !/^https?:\/\//i.test(source) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(source)) return null;
  if (/^https?:\/\/[^/@\s]*@/i.test(source)) return null;
  let u: URL;
  try {
    u = new URL(source);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const m = /^\/(abs|pdf)\/(.+)$/i.exec(path);
    if (!m) return null;
    let id = m[2]!;
    if (m[1]!.toLowerCase() === 'pdf' && id.toLowerCase().endsWith('.pdf')) id = id.slice(0, -4);
    if (!id || id.includes('..')) return null;
    u.protocol = 'https:';
    u.hostname = 'arxiv.org';
    u.pathname = `/abs/${id}`;
  } else {
    u.hostname = host;
  }
  try {
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(decodeURIComponent(`${u.pathname}${u.search}`))) return null;
  } catch {
    return null;
  }
  const kept = [...u.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
  u.search = new URLSearchParams(kept).toString();
  return u.href;
}

/** First 20 hex characters of the SHA-256 digest of the canonical source URL. */
export async function radarPaperId(source: string): Promise<string | null> {
  const canonical = canonicalRadarUrl(source);
  if (canonical === null) return null;
  const bytes = new TextEncoder().encode(canonical);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20);
}

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Valid Radar decision lines in file order; malformed/duplicate lines are an unreadable state, never an empty success. */
export function parseRadarDecisionLines(text: string | null): RadarDecisionLine[] {
  if (text === null || text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body === '') throw new RadarDecisionUnreadableError('invalid-jsonl', 'blank line in Radar decision file');
  const lines: RadarDecisionLine[] = [];
  const seen = new Set<string>();
  for (const raw of body.split('\n')) {
    if (raw === '') throw new RadarDecisionUnreadableError('invalid-jsonl', 'blank line in Radar decision file');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RadarDecisionUnreadableError('invalid-jsonl', 'Radar decision file is not JSONL');
    }
    if (!object(value) || value.schemaVersion !== 1) {
      throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision file contains an unsupported line');
    }
    const parsed = RadarDecisionLine.safeParse(value);
    if (!parsed.success) throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision file contains an unsupported line');
    if (seen.has(parsed.data.decisionId)) throw new RadarDecisionUnreadableError('duplicate-id', 'Radar decision file contains a duplicate decision ID');
    seen.add(parsed.data.decisionId);
    lines.push(parsed.data);
  }
  return lines;
}

export interface RadarDecisionMonth {
  readonly month: string;
  readonly lines: readonly RadarDecisionLine[];
}

const RADAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Validates monthly logs in authoritative append order (oldest first). Undo must name an earlier, still-active,
 * same-paper decision in the same or immediately previous month. Duplicate IDs, duplicate targets, cross-paper and
 * future targets are an unreadable state.
 */
export function validateRadarDecisionMonths(months: readonly RadarDecisionMonth[]): RadarDecisionLine[] {
  const seen = new Set<string>();
  const decisionById = new Map<string, { line: RadarDecisionLine; month: string }>();
  const undone = new Set<string>();
  const lines: RadarDecisionLine[] = [];
  let totalLines = 0;
  let previous: string | null = null;
  for (const entry of months) {
    if (!RADAR_MONTH.test(entry.month)) {
      throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision history has an invalid month');
    }
    if (previous !== null && entry.month <= previous) {
      throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision history is not in month order');
    }
    previous = entry.month;
    for (const line of entry.lines) {
      if (seen.has(line.decisionId)) throw new RadarDecisionUnreadableError('duplicate-id', 'Radar decision file contains a duplicate decision ID');
      if ((line.decision === 'undo') !== (line.undoes !== null)) {
        throw new RadarDecisionUnreadableError('unsupported-line', 'Radar decision file contains a malformed undo line');
      }
      if (line.undoes !== null) {
        const target = decisionById.get(line.undoes);
        if (!target || target.line.decision === 'undo') {
          throw new RadarDecisionUnreadableError('invalid-undo', 'Radar decision file contains an undo to an invalid target');
        }
        if (target.line.paperId !== line.paperId) {
          throw new RadarDecisionUnreadableError('invalid-undo', 'Radar decision file contains an undo to a different paper');
        }
        if (undone.has(line.undoes)) {
          throw new RadarDecisionUnreadableError('invalid-undo', 'Radar decision file contains a duplicate undo target');
        }
        const targetMonth = target.month;
        if (targetMonth !== entry.month && targetMonth !== previousRadarMonth(entry.month)) {
          throw new RadarDecisionUnreadableError('invalid-undo', 'Radar decision file contains an undo outside the previous month');
        }
        undone.add(line.undoes);
      }
      seen.add(line.decisionId);
      decisionById.set(line.decisionId, { line, month: entry.month });
      lines.push(line);
      totalLines += 1;
      if (totalLines > MAX_RADAR_DECISION_LINES) {
        throw new RadarDecisionUnreadableError('too-much-history', 'Radar decision history exceeds 5000 lines');
      }
    }
  }
  return lines;
}

/** Also finds an ID in an otherwise malformed object: never append a second copy of that ID. */
export function hasRadarDecisionId(text: string | null, id: string): boolean {
  return (text ?? '').split('\n').some((line) => {
    const value = json(line);
    return object(value) && value.decisionId === id;
  });
}

/** Exact ordered line: schemaVersion, decisionId, paperId, decision, undoes, at, card. */
export function appendRadarDecisionLine(text: string | null, line: RadarDecisionLine): Uint8Array {
  const ordered = {
    schemaVersion: 1,
    decisionId: line.decisionId,
    paperId: line.paperId,
    decision: line.decision,
    undoes: line.undoes,
    at: line.at,
    card: { title: line.card.title, source: line.card.source, topic: line.card.topic },
  };
  const prefix = text ?? '';
  return new TextEncoder().encode(prefix + (prefix && !prefix.endsWith('\n') ? '\n' : '') + JSON.stringify(ordered) + '\n');
}

export interface ParsedRadarApplied {
  readonly applied: Record<string, RadarAppliedEntry>;
  readonly appliedUpdatedAt: string | null;
}

/** Desktop-owned `Radar/applied.json` is unreadable when its envelope or timestamp is not a valid Radar state. */
export class RadarAppliedUnreadableError extends Error {}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Desktop-owned `Radar/applied.json`; applied entries need a safe Library path, failed entries may have none. */
export function parseRadarApplied(text: string | null): ParsedRadarApplied {
  const empty: ParsedRadarApplied = { applied: {}, appliedUpdatedAt: null };
  if (text === null) return empty;
  const value = json(text);
  if (value === null || !object(value) || value.schemaVersion !== 1 || !object(value.decisions)) {
    throw new RadarAppliedUnreadableError('Radar applied state is not a valid Radar JSON object');
  }
  const updatedAt = value.updatedAt;
  if (updatedAt !== null && updatedAt !== undefined && (typeof updatedAt !== 'string' || !ISO_INSTANT.test(updatedAt) || Number.isNaN(Date.parse(updatedAt)))) {
    throw new RadarAppliedUnreadableError('Radar applied state has an invalid updatedAt timestamp');
  }
  const applied: Record<string, RadarAppliedEntry> = {};
  for (const [id, raw] of Object.entries(value.decisions)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !object(raw)) continue;
    const parsed = RadarAppliedEntry.strip().safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.status === 'applied') {
      if (parsed.data.libraryPath === null || !isResearchLibraryPath(parsed.data.libraryPath)) continue;
    } else if (parsed.data.libraryPath !== null && !isResearchLibraryPath(parsed.data.libraryPath)) {
      continue;
    }
    applied[id] = parsed.data;
  }
  return { applied, appliedUpdatedAt: typeof updatedAt === 'string' ? updatedAt : null };
}
