// ADR-0025: only the sessions table is interpreted. Original lines are never reformatted.
import type { MutationOk, Refusal } from './api.ts';
import { joinDoc, refuse, splitDoc } from './text.ts';
import { scanLines } from './scan.ts';

export const TRAINING_HEADER = '| Date | Time | Type | Distance | Duration | Weight | Split | Note |';
export type TrainingRow = { date: string; time: string; type: string; distance: string; duration: string; weight: string; split: string; note: string };
export type TrainingEffect = { kind: 'training'; op: 'logged' | 'undone'; lineText: string };
export type TrainingSession = { when: string; duration: number; note?: string | undefined } & (
  { type: 'Run'; distance: number } | { type: 'Gym'; split: 'Bicep' | 'Tricep' | 'Legs'; weight?: number | undefined }
);
const missing = () => refuse('refused:training-table-missing', 'Training log table not found — fix it in Obsidian');

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
const tableLine = (line: string) => line.trim().startsWith('|');
export function parseTraining(source: string) {
  const doc = splitDoc(source);
  if ('ok' in doc) return doc;
  // Mask indented code and blockquotes before scanning: neither can open/close a top-level fence.
  const codeOrQuote = (line: string) => /^(?: {4}| {0,3}\t| {0,3}>)/.test(line);
  const scan = scanLines(doc.lines.map((line) => codeOrQuote(line) ? '' : line));
  const visible = (i: number) => scan.visible[i] && !codeOrQuote(doc.lines[i]!);
  const pipeLine = (i: number) => visible(i) && tableLine(doc.lines[i]!);
  const headings = doc.lines.flatMap((line, i) => visible(i) && line.trim() === '## Sessions' ? [i] : []);
  if (headings.length !== 1) return missing();
  const start = headings[0]! + 1;
  let end = doc.lines.findIndex((line, i) => i >= start && visible(i) && /^##(?:\s|$)/.test(line.trim()));
  if (end < 0) end = doc.lines.length;
  const tables: number[] = [];
  for (let i = start; i < end; i++) {
    const next = i + 1 < end && pipeLine(i + 1) ? cells(doc.lines[i + 1]!) : [];
    const headerPair = cells(doc.lines[i]!).length > 0 && next.length > 0 && next.every((c) => /^:?-{3,}:?$/.test(c));
    if (pipeLine(i) && (i === start || !pipeLine(i - 1) || headerPair)) tables.push(i);
  }
  if (tables.length !== 1) return missing();
  const header = tables[0]!;
  if (JSON.stringify(cells(doc.lines[header]!)) !== JSON.stringify(cells(TRAINING_HEADER))) return missing();
  const separator = doc.lines[header + 1] ?? '';
  if (!visible(header + 1) || cells(separator).length !== 8 || !cells(separator).every((c) => /^:?-{3,}:?$/.test(c))) return missing();
  let tableEnd = header + 2;
  while (tableEnd < end && pipeLine(tableEnd)) tableEnd++;
  const rows: (TrainingRow & { lineIndex: number })[] = [];
  const unknownLines: string[] = [];
  for (let i = header + 2; i < tableEnd; i++) {
    const line = doc.lines[i]!;
    const c = cells(line);
    const [date = '', time = '', type = '', distance = '', duration = '', weight = '', split = '', note = ''] = c;
    if (line.trim().endsWith('|') && c.length === 8 && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date &&
      (time === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) {
      rows.push({ date, time, type, distance, duration, weight, split, note, lineIndex: i });
    } else unknownLines.push(line);
  }
  return { ok: true as const, doc, rows, unknownLines, tableEnd };
}

/** The single canonical formatter, including Copenhagen wall time and Markdown escaping. */
export function formatTrainingRow(session: TrainingSession): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(session.when));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const note = (session.note ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().replaceAll('\\', '\\\\').replaceAll('|', '\\|');
  const values = [`${part('year')}-${part('month')}-${part('day')}`, `${part('hour')}:${part('minute')}`, session.type,
    session.type === 'Run' ? session.distance.toFixed(1) : '', String(session.duration),
    session.type === 'Gym' && session.weight !== undefined ? session.weight.toFixed(1) : '', session.type === 'Gym' ? session.split : '', note];
  return '|' + values.map((v) => v ? ` ${v} ` : ' ').join('|') + '|';
}

export function insertTrainingRow(source: string, session: TrainingSession): MutationOk<TrainingEffect> | Refusal {
  const parsed = parseTraining(source);
  if (!parsed.ok) return parsed;
  const lineText = formatTrainingRow(session);
  const c = cells(lineText);
  const key = c[0]! + c[1]!;
  const at = parsed.rows.find((r) => r.date + r.time < key)?.lineIndex ?? parsed.tableEnd;
  const lines = [...parsed.doc.lines];
  lines.splice(at, 0, lineText);
  return { ok: true, text: joinDoc(parsed.doc, lines), effect: { kind: 'training', op: 'logged', lineText } };
}

export function undoTraining(source: string, target: string, parent: string, effect: TrainingEffect): MutationOk<TrainingEffect> | Refusal {
  if (source !== target) return refuse('refused:undo-expired', 'Cannot restore the exact previous file; undo it in Obsidian.');
  return { ok: true, text: parent, effect: { ...effect, op: 'undone' } };
}
