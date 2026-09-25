import type { ParsedTask, ParseResult, Refusal } from './api.ts';
import { PRIORITY_BY_EMOJI, parseTaskBody, type TaskFields } from './fields.ts';
import { scanLines, type LineScan } from './scan.ts';
import { indentWidth, isBlank, isListItem, refuse, splitDoc, type Doc } from './text.ts';

// docs/vault-contract.md §2 (Tasks bundle regex). `u`: the status char is one code point.
const TASK_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/u;
// Spec: `^<{7} `, `^={7}$`, `^>{7} `, `^\|{7} `. A bare marker at end of line is also refused (strict superset).
const CONFLICT_MARKER = /^(?:<{7}(?: |$)|={7}$|>{7}(?: |$)|\|{7}(?: |$))/;

export interface TaskLineMatch {
  readonly indent: string;
  readonly statusChar: string;
  /** Offset of `[` in the line. */
  readonly checkboxOffset: number;
  readonly body: string;
}

export function matchTaskLine(line: string): TaskLineMatch | null {
  const m = TASK_LINE.exec(line);
  if (!m) return null;
  const indent = m[1]!;
  const marker = m[2]!;
  const checkboxOffset = line.indexOf('[', indent.length + marker.length);
  return { indent, statusChar: m[3]!, checkboxOffset, body: m[4]! };
}

export interface Section {
  /** Line index of the `## Open` / `## Done` heading. */
  readonly heading: number;
  /** Exclusive end: next visible heading of level ≤ 2, or end of file. */
  readonly end: number;
}

export interface IndexedTask {
  readonly lineIndex: number;
  readonly lineText: string;
  readonly match: TaskLineMatch;
  readonly section: 'open' | 'done';
  /** Exclusive end of the task block. */
  readonly blockEnd: number;
  readonly parsed: ParsedTask;
}

export interface Analysis {
  readonly doc: Doc;
  readonly scan: LineScan;
  readonly open: Section | null;
  readonly done: Section | null;
  /** A heading of level ≥ 3 inside `## Open` (capture is refused: QuickAdd subsections not reproduced). */
  readonly openHasSubheading: boolean;
  readonly writeBlock: Refusal | null;
  readonly tasks: readonly IndexedTask[];
}

export function analyse(text: string): Analysis | Refusal {
  const doc = splitDoc(text);
  if ('ok' in doc) return doc;
  return analyseDoc(doc);
}

export function analyseDoc(doc: Doc): Analysis {
  const { lines } = doc;
  const scan = scanLines(lines);
  const headings: { index: number; level: number; title: string }[] = [];
  let conflict = false;
  lines.forEach((line, index) => {
    if (CONFLICT_MARKER.test(line)) conflict = true;
    if (!scan.visible[index]) return;
    const h = HEADING.exec(line);
    if (h) headings.push({ index, level: h[1]!.length, title: h[2]!.trim() });
  });

  const sectionsTitled = (title: string): Section[] =>
    headings
      .filter((h) => h.level === 2 && h.title === title)
      .map((h) => {
        const next = headings.find((o) => o.index > h.index && o.level <= 2);
        return { heading: h.index, end: next ? next.index : lines.length };
      });
  const opens = sectionsTitled('Open');
  const dones = sectionsTitled('Done');
  const open = opens.length === 1 ? opens[0]! : null;
  const done = dones.length === 1 ? dones[0]! : null;
  const openHasSubheading = open !== null && headings.some((h) => h.index > open.heading && h.index < open.end);

  let writeBlock: Refusal | null = null;
  if (conflict) writeBlock = refuse('refused:vault-conflict', 'File contains Git conflict markers.');
  else if (!open || !done) writeBlock = refuse('refused:structure', 'File needs exactly one "## Open" and one "## Done" heading.');

  const found: { lineIndex: number; match: TaskLineMatch; section: 'open' | 'done'; fields: TaskFields }[] = [];
  lines.forEach((line, lineIndex) => {
    if (!scan.visible[lineIndex]) return;
    const section = within(open, lineIndex) ? 'open' : within(done, lineIndex) ? 'done' : null;
    if (!section) return;
    const match = matchTaskLine(line);
    if (!match || match.indent !== '') return;
    const fields = parseTaskBody(match.body);
    if (!fields.tags.includes('#todo')) return;
    found.push({ lineIndex, match, section, fields });
  });

  const occurrences = new Map<string, number>();
  for (const f of found) {
    const text = lines[f.lineIndex]!;
    occurrences.set(text, (occurrences.get(text) ?? 0) + 1);
  }

  const tasks = found.map(({ lineIndex, match, section, fields }): IndexedTask => {
    const lineText = lines[lineIndex]!;
    const blockEnd = taskBlockEnd(lines, lineIndex);
    const blockSafe = scan.cleanAfter[blockEnd - 1] === true;
    const v = fields.values;
    const statusChar = match.statusChar;
    const status =
      statusChar === ' ' ? 'open' : statusChar === 'x' || statusChar === 'X' ? (v.cancelled ? 'cancelled' : 'done') : 'other';
    const parsed: ParsedTask = {
      lineIndex,
      lineText,
      occurrences: occurrences.get(lineText)!,
      section,
      statusChar,
      status,
      description: fields.description,
      priority: v.priority ? PRIORITY_BY_EMOJI[v.priority]! : null,
      due: v.due ?? null,
      scheduled: v.scheduled ?? null,
      start: v.start ?? null,
      created: v.created ?? null,
      done: v.done ?? null,
      cancelled: v.cancelled ?? null,
      recurrence: v.recurrence ?? null,
      onCompletion: v.onCompletion ?? null,
      id: v.id ?? null,
      blockId: fields.blockId,
      tags: fields.tags,
      links: fields.links,
      blockLineCount: blockEnd - lineIndex,
      readOnlyReason: readOnlyReason(status, fields, blockSafe),
    };
    return { lineIndex, lineText, match, section, blockEnd, parsed };
  });

  return { doc, scan, open, done, openHasSubheading, writeBlock, tasks };
}

function readOnlyReason(status: ParsedTask['status'], fields: TaskFields, blockSafe: boolean): ParsedTask['readOnlyReason'] {
  if (status === 'other') return 'refused:unsupported-status';
  // An open task that already carries a trailing ✅/❌ would get a second one on completion.
  if (fields.duplicateField || (status === 'open' && (fields.values.done || fields.values.cancelled))) {
    return 'refused:duplicate-field';
  }
  if (fields.values.recurrence !== undefined) return 'refused:recurring';
  if (fields.values.onCompletion !== undefined) return 'refused:on-completion';
  // The block would end inside a fence/comment it opened: moving it would re-interpret the rest of the file.
  if (!blockSafe) return 'refused:structure';
  return null;
}

export function within(section: Section | null, index: number): boolean {
  return section !== null && index > section.heading && index < section.end;
}

/**
 * §2 "Task block": the task line plus following lines indented strictly deeper; a blank line belongs to the
 * block only if the next non-blank line is indented deeper than the task line.
 */
export function taskBlockEnd(lines: readonly string[], taskIndex: number): number {
  const base = indentWidth(lines[taskIndex]!);
  let end = taskIndex + 1;
  let j = taskIndex + 1;
  while (j < lines.length) {
    const line = lines[j]!;
    if (isBlank(line)) {
      j++;
      continue;
    }
    if (indentWidth(line) <= base) break;
    j++;
    end = j;
  }
  return end;
}

/**
 * §4.4 (D4, ADR-0010): top of `## Open`, immediately before its first non-blank line. If Open has no non-blank
 * line: after the heading, preceded by exactly one blank line (an existing blank line is reused).
 * Refused when that first line is indented (the inserted task would adopt it as a child line) or is not a list
 * item (prose would become a lazy continuation of the inserted task — review R14).
 */
export function captureInsertionPoint(
  lines: readonly string[],
  open: Section,
): { readonly at: number; readonly blankBefore: boolean } | Refusal {
  for (let j = open.heading + 1; j < open.end; j++) {
    const line = lines[j]!;
    if (isBlank(line)) continue;
    if (indentWidth(line) > 0) return refuse('refused:structure', '"## Open" starts with an indented line.');
    if (!isListItem(line)) return refuse('refused:structure', '"## Open" starts with a line that is not a list item.');
    return { at: j, blankBefore: false };
  }
  if (open.heading + 1 < open.end) return { at: open.heading + 2, blankBefore: false };
  return { at: open.heading + 1, blankBefore: true };
}

/** Parse `Tasks/To-Do List.md` per docs/vault-contract.md §2. */
export function parseTodoList(text: string): ParseResult {
  const a = analyse(text);
  if ('ok' in a) return a;
  return {
    ok: true,
    eol: a.doc.eol,
    hasFinalNewline: a.doc.finalNewline,
    writeBlock: a.writeBlock,
    tasks: a.tasks.map((t) => t.parsed),
  };
}
