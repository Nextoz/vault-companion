// ADR-0053: only the Kinds and Log tables are interpreted. Original lines are never reformatted.
import type { MutationOk, Refusal } from './api.ts';
import { joinDoc, refuse, splitDoc } from './text.ts';
import { scanLines } from './scan.ts';

export const LEARNING_KINDS_HEADER = '| id | Name | Score means | Status |';
export const LEARNING_LOG_HEADER = '| Date | Kind | Min | Score | Detail | Topic or source | Note |';

export type LearningKind = { id: string; name: string; scoreMeans: string; status: string };
export type LearningRow = { date: string; kind: string; minutes: string; score: string; detail: string; topic: string; note: string };
export type LearningEffect = { kind: 'learning'; op: 'logged' | 'undone'; lineText: string };
export type LearningSession = {
  kind: string;
  date: string;
  minutes?: number | undefined;
  score?: number | string | undefined;
  detail?: string | undefined;
  topic?: string | undefined;
  note?: string | undefined;
};
export type LearningPaste = { kind: string; date: string; minutes: number; score: string; detail: string; topic: string };

const missing = () => refuse('refused:learning-table-missing', 'Learning Gym Log table not found — fix it in Obsidian');
const pasteInvalid = () => refuse('refused:learning-paste-invalid', 'Paste line does not match LG | kind | date | min n | score n | key n | topic: text');

/** A table cell escapes backslash first, then pipe — the same bytes the Note cell has always used. */
const escapeCell = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('|', '\\|');

/** Escaped pipes belong to a cell; backslashes are decoded only when escaping a pipe or another backslash. */
function cells(line: string): string[] {
  if (!line.trim().startsWith('|') || !line.trim().endsWith('|')) return [];
  const body = line.trim().slice(1, -1);
  const result: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && (body[i + 1] === '|' || body[i + 1] === '\\')) cell += body[++i];
    else if (body[i] === '|') { result.push(cell.trim()); cell = ''; }
    else cell += body[i];
  }
  result.push(cell.trim());
  return result;
}

const separatorCell = (c: string) => /^:?-{3,}:?$/.test(c);
const tableLine = (line: string) => line.trim().startsWith('|');
const isCodeOrQuote = (line: string) => /^(?: {4}| {0,3}\t| {0,3}>)/.test(line);
const isValidDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

type SectionTable = { header: number; tableEnd: number };

function sectionTable(
  lines: readonly string[],
  visible: readonly boolean[],
  start: number,
  end: number,
  expectedHeader: string,
): SectionTable | Refusal {
  const pipeLine = (i: number) => i >= start && i < end && visible[i]! && tableLine(lines[i]!);
  const expected = cells(expectedHeader);
  const tables: number[] = [];
  for (let i = start; i < end; i++) {
    const next = pipeLine(i + 1) ? cells(lines[i + 1]!) : [];
    const headerPair = cells(lines[i]!).length > 0 && next.length > 0 && next.every(separatorCell);
    if (pipeLine(i) && (i === start || !pipeLine(i - 1) || headerPair)) tables.push(i);
  }
  if (tables.length !== 1) return missing();
  const header = tables[0]!;
  if (JSON.stringify(cells(lines[header]!)) !== JSON.stringify(expected)) return missing();
  const separator = lines[header + 1] ?? '';
  if (!pipeLine(header + 1) || cells(separator).length !== expected.length || !cells(separator).every(separatorCell)) return missing();
  let tableEnd = header + 2;
  while (tableEnd < end && pipeLine(tableEnd)) tableEnd++;
  return { header, tableEnd };
}

export function parseLearning(source: string) {
  const doc = splitDoc(source);
  if ('ok' in doc) return doc;
  // Mask indented code and blockquotes before scanning: neither can open/close a top-level fence.
  const scan = scanLines(doc.lines.map((line) => isCodeOrQuote(line) ? '' : line));
  const visible = (i: number) => scan.visible[i] && !isCodeOrQuote(doc.lines[i]!);
  const headingIndexes = (heading: string) => doc.lines.flatMap((line, i) => visible(i) && line.trim() === heading ? [i] : []);
  const section = (heading: string) => {
    const headings = headingIndexes(heading);
    if (headings.length !== 1) return missing();
    const start = headings[0]! + 1;
    let end = doc.lines.findIndex((line, i) => i >= start && visible(i) && /^##(?:\s|$)/.test(line.trim()));
    if (end < 0) end = doc.lines.length;
    return { start, end };
  };
  const kindsSection = section('## Kinds');
  if (!('start' in kindsSection)) return kindsSection;
  const logSection = section('## Log');
  if (!('start' in logSection)) return logSection;
  const kindsTable = sectionTable(doc.lines, scan.visible, kindsSection.start, kindsSection.end, LEARNING_KINDS_HEADER);
  if (!('header' in kindsTable)) return kindsTable;
  const logTable = sectionTable(doc.lines, scan.visible, logSection.start, logSection.end, LEARNING_LOG_HEADER);
  if (!('header' in logTable)) return logTable;

  const kinds: LearningKind[] = [];
  for (let i = kindsTable.header + 2; i < kindsTable.tableEnd; i++) {
    const c = cells(doc.lines[i]!);
    if (c.length === 4 && c[0] !== '') kinds.push({ id: c[0]!, name: c[1]!, scoreMeans: c[2]!, status: c[3]! });
  }

  const rows: (LearningRow & { lineIndex: number })[] = [];
  const unknownLines: string[] = [];
  for (let i = logTable.header + 2; i < logTable.tableEnd; i++) {
    const line = doc.lines[i]!;
    const c = cells(line);
    const [date = '', kind = '', minutes = '', score = '', detail = '', topic = '', note = ''] = c;
    if (line.trim().endsWith('|') && c.length === 7 && isValidDate(date)) {
      rows.push({ date, kind, minutes, score, detail, topic, note, lineIndex: i });
    } else unknownLines.push(line);
  }

  return {
    ok: true as const,
    doc,
    kinds,
    rows,
    unknownLines,
    logHeader: logTable.header,
    logTableEnd: logTable.tableEnd,
  };
}

/** The single canonical formatter: escaped, single-line cells and an empty cell rendered as one space. */
export function formatLearningRow(session: LearningSession): string {
  const text = (value: string | number | undefined) => escapeCell(String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim());
  const values = [
    text(session.date),
    text(session.kind),
    text(session.minutes),
    text(session.score),
    text(session.detail),
    text(session.topic),
    text(session.note),
  ];
  return '|' + values.map((v) => v ? ` ${v} ` : ' ').join('|') + '|';
}

export function insertLearningRow(source: string, session: LearningSession): MutationOk<LearningEffect> | Refusal {
  const parsed = parseLearning(source);
  if (!parsed.ok) return parsed;
  if (!parsed.kinds.some((k) => k.id === session.kind)) {
    return refuse('refused:learning-kind-unknown', 'That kind is not in the Kinds table — add it there first.');
  }
  const lineText = formatLearningRow(session);
  const lines = [...parsed.doc.lines];
  // ADR-0053: one new row, always at the end of the `## Log` table.
  lines.splice(parsed.logTableEnd, 0, lineText);
  return { ok: true, text: joinDoc(parsed.doc, lines), effect: { kind: 'learning', op: 'logged', lineText } };
}

export function undoLearning(source: string, target: string, parent: string, effect: LearningEffect): MutationOk<LearningEffect> | Refusal {
  if (source !== target) return refuse('refused:undo-expired', 'Cannot restore the exact previous file; undo it in Obsidian.');
  return { ok: true, text: parent, effect: { ...effect, op: 'undone' } };
}

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
export function parseLearningPasteLine(source: string): LearningPaste | Refusal {
  const line = source.trim();
  const parts = splitPaste(line);
  if (parts.length < 6 || parts[0] !== 'LG') return pasteInvalid();
  const kind = parts[1]!;
  const date = parts[2]!;
  const minMatch = /^min\s+(\d+)$/.exec(parts[3]!);
  const scoreMatch = /^score\s+(\d+|\d+\/\d+)$/.exec(parts[4]!);
  const topic = parts.at(-1)!;
  const topicMatch = /^topic:\s*(.*)$/.exec(topic);
  if (!minMatch || !scoreMatch || !topicMatch) return pasteInvalid();
  if (kind === '' || !isValidDate(date)) return pasteInvalid();
  const score = scoreMatch[1]!;
  if (score.length > 8 || /[\r\n|]/.test(score)) return pasteInvalid();
  const detailParts: string[] = [];
  for (const raw of parts.slice(5, -1)) {
    const pair = /^([^\s|]+)\s+(\d+(?:\.\d+)?)$/.exec(raw);
    if (!pair) return pasteInvalid();
    detailParts.push(`${pair[1]} ${pair[2]}`);
  }
  const topicText = topicMatch[1]!.trim();
  if (topicText === '') return pasteInvalid();
  return { kind, date, minutes: Number(minMatch[1]), score, detail: detailParts.join(', '), topic: topicText };
}
