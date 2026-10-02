// ADR-0040: one byte-faithful feedback line in the Ready Backlog note, plus its exact inverse.
import type { MutationOk, Refusal } from './api.ts';
import { joinDoc, refuse, splitDoc } from './text.ts';

export interface FeedbackReportInput {
  readonly kind: 'bug' | 'wish';
  readonly text: string;
  readonly screen: string;
  readonly appVersion: string;
  readonly date: string;
}

export interface FeedbackReportEffect {
  readonly kind: 'feedback-report';
  readonly lineText: string;
}

const BUG_HEADING = '## Bug backlog';
const WISH_HEADING = '## Candidates to refine next';
const BUG_HEADER = '| Bug | Seen | Expected | Likely cause (hint) |';
const TABLE_SEPARATOR = /^\|(?:[ \t]*:?-+:?[ \t]*\|)+$/;
const B_NUMBER = /\bB(\d+)\b/g;
const SCREEN = /^[A-Za-z][A-Za-z0-9 -]{0,30}$/;
const APP_VERSION = /^[0-9A-Za-z.+-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const midnight = `${value}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(midnight)) && new Date(midnight).toISOString().slice(0, 10) === value;
}

function validInput(input: FeedbackReportInput): boolean {
  return (input.kind === 'bug' || input.kind === 'wish') && SCREEN.test(input.screen) && APP_VERSION.test(input.appVersion) && isValidDate(input.date);
}

function sanitiseText(input: FeedbackReportInput): string | null {
  const text = input.text.replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
  return text.length >= 1 && text.length <= 1000 ? text : null;
}

function titleOf(sanitised: string): string {
  return sanitised.replace(/[*[\]`]/g, '').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
}

function headingIndex(lines: readonly string[], heading: string): number | Refusal {
  let index: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== heading) continue;
    if (index !== null) return refuse('refused:structure', `The note has more than one ${heading} heading.`);
    index = i;
  }
  return index === null ? refuse('refused:structure', `${heading} was not found.`) : index;
}

function bugInsertIndex(lines: readonly string[]): number | Refusal {
  const heading = headingIndex(lines, BUG_HEADING);
  if (typeof heading !== 'number') return heading;
  for (let i = heading + 1; i < lines.length; i++) {
    if (lines[i] === BUG_HEADER && lines[i + 1] !== undefined && TABLE_SEPARATOR.test(lines[i + 1]!)) return i + 2;
  }
  return refuse('refused:structure', 'The Bug backlog table was not found.');
}

function wishInsertIndex(lines: readonly string[]): number | Refusal {
  const heading = headingIndex(lines, WISH_HEADING);
  if (typeof heading !== 'number') return heading;
  let last = -1;
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('- ')) { last = i; continue; }
    if (last !== -1) break;
  }
  return last === -1 ? refuse('refused:structure', 'The Candidates to refine next bullet list was not found.') : last + 1;
}

function nextBugNumber(text: string): number {
  let max = 0;
  for (const match of text.matchAll(B_NUMBER)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  return max + 1;
}

export function applyFeedbackReport(text: string, input: FeedbackReportInput): MutationOk<FeedbackReportEffect> | Refusal {
  if (!validInput(input)) return refuse('invalid', 'Feedback report values are invalid.');
  const sanitised = sanitiseText(input);
  if (sanitised === null) return refuse('invalid', 'Feedback text must be 1 to 1000 characters after trim.');
  const doc = splitDoc(text);
  if ('ok' in doc) return doc;
  const meta = `${input.date} ${input.screen} (app ${input.appVersion})`;
  const insertIndex = input.kind === 'bug' ? bugInsertIndex(doc.lines) : wishInsertIndex(doc.lines);
  if (typeof insertIndex !== 'number') return insertIndex;
  const title = titleOf(sanitised);
  const lineText = input.kind === 'bug' ? `| **B${nextBugNumber(text)} - ${title}** | ${meta}: ${sanitised} | | |` : `- **${title}**: ${meta}: ${sanitised}`;
  const lines = [...doc.lines];
  lines.splice(insertIndex, 0, lineText);
  return { ok: true, text: joinDoc(doc, lines), effect: { kind: 'feedback-report', lineText } };
}

export function revertFeedbackReport(text: string, appliedLine: string): MutationOk<FeedbackReportEffect> | Refusal {
  const doc = splitDoc(text);
  if ('ok' in doc) return doc;
  let index = -1;
  for (let i = 0; i < doc.lines.length; i++) {
    if (doc.lines[i] !== appliedLine) continue;
    if (index !== -1) return refuse('conflict:report-changed', 'The report line appears more than once; undo it in Obsidian.');
    index = i;
  }
  if (index === -1) return refuse('conflict:report-changed', 'The report line is no longer in the note; undo it in Obsidian.');
  return { ok: true, text: joinDoc(doc, doc.lines.filter((_, i) => i !== index)), effect: { kind: 'feedback-report', lineText: appliedLine } };
}
