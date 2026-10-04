// LG1b: pure helpers for the Learning screen — calendar arithmetic, score parsing, paste-to-draft mapping.
// No React here: the same rules are unit-tested without a DOM. The paste grammar mirrors the kernel
// (packages/vault-markdown, ADR-0053) because `apps/web/src` may talk to /api via contracts only; the
// unit test proves the two parsers agree line for line.
import type { LearningRow, LearningSession } from '@vault-companion/contracts';
import { addDays, mondayOf, type Bar } from './week-chart.ts';

/** The Learning paste grammar's parsed result, the same shape the kernel returns. */
export interface LearningPaste {
  kind: string;
  date: string;
  minutes: number;
  score: string;
  detail: string;
  topic: string;
}

export type PasteResult = { ok: true; paste: LearningPaste } | { ok: false; message: string };

const PASTE_INVALID = 'Paste line does not match LG | kind | date | min n | score n | key n | topic: text';

const isValidPasteDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

/** Split on unescaped pipes, decoding `\|` and `\\` — the same rule the kernel's paste splitter uses. */
function splitPaste(line: string): string[] {
  const result: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && (line[i + 1] === '|' || line[i + 1] === '\\')) cell += line[++i];
    else if (line[i] === '|') { result.push(cell.trim()); cell = ''; }
    else cell += line[i];
  }
  result.push(cell.trim());
  return result;
}

/** ADR-0053 paste helper: `LG | kind | date | min n | score n | key n ... | topic: text`. */
export function parsePasteLine(source: string): PasteResult {
  const parts = splitPaste(source.trim());
  if (parts.length < 6 || parts[0] !== 'LG') return { ok: false, message: PASTE_INVALID };
  const kind = parts[1]!;
  const date = parts[2]!;
  const minMatch = /^min\s+(\d+)$/.exec(parts[3]!);
  const scoreMatch = /^score\s+(\d+|\d+\/\d+)$/.exec(parts[4]!);
  const topicMatch = /^topic:\s*(.*)$/.exec(parts.at(-1)!);
  if (!minMatch || !scoreMatch || !topicMatch) return { ok: false, message: PASTE_INVALID };
  if (kind === '' || !isValidPasteDate(date)) return { ok: false, message: PASTE_INVALID };
  const score = scoreMatch[1]!;
  if (score.length > 8 || /[\r\n|]/.test(score)) return { ok: false, message: PASTE_INVALID };
  const detailParts: string[] = [];
  for (const raw of parts.slice(5, -1)) {
    const pair = /^([^\s|]+)\s+(\d+(?:\.\d+)?)$/.exec(raw);
    if (!pair) return { ok: false, message: PASTE_INVALID };
    detailParts.push(`${pair[1]} ${pair[2]}`);
  }
  const topic = topicMatch[1]!.trim();
  if (topic === '') return { ok: false, message: PASTE_INVALID };
  return { ok: true, paste: { kind, date, minutes: Number(minMatch[1]), score, detail: detailParts.join(', '), topic } };
}

/** The sheet's controlled inputs; every field is a string so an unparseable cell stays empty. */
export interface LearningDraft {
  kind: string;
  date: string;
  minutes: string;
  score: string;
  detail: string;
  topic: string;
  note: string;
}

/** A fresh draft: the date defaults to the owner's Copenhagen day, the kind waits for a tap. */
export function newLearningDraft(today: string): LearningDraft {
  return { kind: '', date: today, minutes: '', score: '', detail: '', topic: '', note: '' };
}

/** ADR-0053 paste output -> the sheet's inputs. A paste line has no note, so the note is cleared. */
export function pasteToDraft(paste: LearningPaste): LearningDraft {
  return {
    kind: paste.kind,
    date: paste.date,
    minutes: String(paste.minutes),
    score: paste.score,
    detail: paste.detail,
    topic: paste.topic,
    note: '',
  };
}

/**
 * Parse a pasted line and map it onto the draft. On `refused:learning-paste-invalid` the draft is returned byte
 * for byte and the message is surfaced for an inline note; nothing on the form changes.
 */
export function applyPasteLine(draft: LearningDraft, line: string): { draft: LearningDraft; error: string | null } {
  const parsed = parsePasteLine(line);
  return parsed.ok ? { draft: pasteToDraft(parsed.paste), error: null } : { draft, error: parsed.message };
}

/**
 * The numeric value a score cell contributes to a trend. `3/5` is the right/asked ratio (0.6), never 3; a plain
 * integer or decimal is itself; anything else has no numeric value.
 */
export function scoreValue(raw: string): number | null {
  const t = raw.trim();
  const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (ratio) {
    const asked = Number(ratio[2]);
    return asked === 0 ? null : Number(ratio[1]) / asked;
  }
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

export interface ScoreTrend {
  /** The kind id exactly as the Log row carries it (the Kinds table names it for the screen). */
  kind: string;
  /** Oldest first, one point per row that has a numeric score. */
  values: number[];
}

/** Per-kind score series, oldest first, only for kinds with at least `min` numeric scores. */
export function scoreTrends(rows: readonly LearningRow[], min = 2): ScoreTrend[] {
  const byKind = new Map<string, number[]>();
  for (const row of [...rows].reverse()) {
    const value = scoreValue(row.score);
    if (value === null) continue;
    const values = byKind.get(row.kind) ?? [];
    values.push(value);
    byKind.set(row.kind, values);
  }
  return [...byKind].filter(([, values]) => values.length >= min).map(([kind, values]) => ({ kind, values }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Counts of dated rows per calendar week, Monday start, oldest first, the last `weeks` weeks, ending on the week
 * that holds `today`. `today` is a Copenhagen calendar date supplied by the caller; the arithmetic is UTC-stable.
 */
export function learningWeekBars(dates: readonly string[], today: string, weeks = 8): Bar[] {
  const thisMonday = mondayOf(today);
  return Array.from({ length: weeks }, (_, i) => {
    const monday = addDays(thisMonday, (i - weeks + 1) * 7);
    const sunday = addDays(monday, 6);
    const d = new Date(`${monday}T00:00:00Z`);
    return {
      label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      value: dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= monday && date <= sunday).length,
      current: monday === thisMonday,
    };
  });
}

/** The Kinds table's display name for a Log row's kind id; an id the table no longer lists falls back to itself. */
export function kindName(kinds: readonly { id: string; name: string }[], id: string): string {
  return kinds.find((kind) => kind.id === id)?.name ?? id;
}

/**
 * The sheet's inputs back to the command's session. An empty optional field is omitted, never sent as 0 or `''`;
 * a numeric score travels as a number so `3/5` stays a ratio string and `7` stays a number.
 */
export function draftToSession(draft: LearningDraft): LearningSession {
  const session: LearningSession = { kind: draft.kind.trim(), date: draft.date };
  const minutes = draft.minutes.trim();
  if (minutes !== '') session.minutes = Number(minutes);
  const score = draft.score.trim();
  if (score !== '') session.score = /^\d+$/.test(score) ? Number(score) : score;
  const detail = draft.detail.trim();
  if (detail !== '') session.detail = detail;
  const topic = draft.topic.trim();
  if (topic !== '') session.topic = topic;
  const note = draft.note.trim();
  if (note !== '') session.note = note;
  return session;
}

/** Stable React keys: row content plus its occurrence number, so a refresh never shows another session's expansion. */
export function learningRowKeys(rows: readonly LearningRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const content = JSON.stringify([row.date, row.kind, row.minutes, row.score, row.detail, row.topic, row.note]);
    const n = (seen.get(content) ?? 0) + 1;
    seen.set(content, n);
    return `${content}#${n}`;
  });
}
