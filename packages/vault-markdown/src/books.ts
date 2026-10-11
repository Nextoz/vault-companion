// ADR-0062: reading book notes (`Books/<Title>.md`).
// Only `## Progress` and `## Reflections` are interpreted; every byte outside the spliced span is preserved
// (BOM, EOL and final-newline state included). Structure problems are typed refusals, never a guess.
import type { MutationOk, Refusal } from './api.ts';
import { scanLines } from './scan.ts';
import { isBlank, ISO_DATE, joinDoc, refuse, splitDoc, type Doc } from './text.ts';

export const PROGRESS_HEADING = '## Progress';
export const REFLECTIONS_HEADING = '## Reflections';

export type BookProgressEntry = { readonly date: string; readonly page: number };
export type BookReflectionEntry = { readonly date: string; readonly text: string };
export type BookFrontmatter = { readonly type: string; readonly author: string; readonly totalPages: number | null; readonly status: string };
/** The kernel effect: enough to name the spliced line for a receipt without ever carrying reflection text. */
export type BookEffect = { readonly kind: 'book'; readonly op: 'logged' | 'reflected' | 'undone'; readonly date: string; readonly lineText: string };

export type ParsedBook = {
  readonly ok: true;
  readonly doc: Doc;
  readonly frontmatter: BookFrontmatter;
  readonly progress: readonly BookProgressEntry[];
  readonly reflections: readonly BookReflectionEntry[];
  /** End of each reflection's nonblank content, parallel to `reflections`. */
  readonly reflectionInsertAts: readonly number[];
  /** The latest `- <date>: p. N` line's page, or 0 when there is none. */
  readonly currentPage: number;
  readonly lastRead: string | null;
  readonly progressInsertAt: number;
  readonly reflectionsInsertAt: number;
  readonly reflectionsHasContent: boolean;
};

const FM_DELIM = /^---[ \t]*$/;
const isDate = (value: string) => ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isCodeOrQuote = (line: string) => /^(?: {4}| {0,3}\t| {0,3}>)/.test(line);
const shape = () => refuse('refused:book-note-shape', 'Book note needs one `## Progress` and one `## Reflections` section — fix it in Obsidian');

function frontmatterOf(lines: readonly string[]): BookFrontmatter | null {
  if (lines.length === 0 || !FM_DELIM.test(lines[0]!)) return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (FM_DELIM.test(lines[i]!)) { close = i; break; }
  if (close < 0) return null;
  const fields = new Map<string, string>();
  for (let i = 1; i < close; i++) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(lines[i]!);
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!.trim());
  }
  const total = fields.get('totalPages');
  return {
    type: fields.get('type') ?? '',
    author: fields.get('author') ?? '',
    totalPages: total !== undefined && /^\d+$/.test(total) ? Number(total) : null,
    status: fields.get('status') ?? '',
  };
}

export function parseBookNote(source: string): ParsedBook | Refusal {
  const doc = splitDoc(source);
  if ('ok' in doc) return doc;
  const frontmatter = frontmatterOf(doc.lines);
  if (frontmatter === null) return shape();
  // Mask indented code and blockquotes before scanning: neither can open or close a top-level fence.
  const scan = scanLines(doc.lines.map((line) => (isCodeOrQuote(line) ? '' : line)));
  const visible = (i: number) => scan.visible[i] === true && !isCodeOrQuote(doc.lines[i]!);
  const indexes = (heading: string) => doc.lines.flatMap((line, i) => (visible(i) && line.trim() === heading ? [i] : []));
  const progressHeadings = indexes(PROGRESS_HEADING);
  const reflectionHeadings = indexes(REFLECTIONS_HEADING);
  if (progressHeadings.length !== 1 || reflectionHeadings.length !== 1) return shape();
  const progressHeading = progressHeadings[0]!;
  const reflectionsHeading = reflectionHeadings[0]!;
  if (progressHeading >= reflectionsHeading) return shape();
  const nextHeading = (from: number) => {
    for (let i = from; i < doc.lines.length; i++) if (visible(i) && /^##(?:\s|$)/.test(doc.lines[i]!.trim())) return i;
    return doc.lines.length;
  };
  const contentEnd = (start: number, end: number) => {
    let last = start - 1;
    for (let i = start; i < end; i++) if (!isBlank(doc.lines[i]!)) last = i;
    return last + 1;
  };

  const progressStart = progressHeading + 1;
  const progressEnd = reflectionsHeading;
  const progress: BookProgressEntry[] = [];
  for (let i = progressStart; i < progressEnd; i++) {
    const m = /^-[ \t]+(\d{4}-\d{2}-\d{2}):[ \t]*p\.[ \t]*(\d+)[ \t]*$/.exec(doc.lines[i]!.trim());
    if (visible(i) && m && isDate(m[1]!)) progress.push({ date: m[1]!, page: Number(m[2]) });
  }
  const latest = progress.at(-1) ?? null;

  const reflectionsStart = reflectionsHeading + 1;
  const reflectionsEnd = nextHeading(reflectionsStart);
  const reflections: BookReflectionEntry[] = [];
  const reflectionInsertAts: number[] = [];
  for (let i = reflectionsStart; i < reflectionsEnd; ) {
    const m = /^###[ \t]+(\S+)[ \t]*$/.exec(doc.lines[i]!.trim());
    if (!visible(i) || !m || !isDate(m[1]!)) { i++; continue; }
    let j = i + 1;
    const body: string[] = [];
    while (j < reflectionsEnd) {
      if (visible(j) && /^###(?:\s|$)/.test(doc.lines[j]!.trim())) break;
      body.push(doc.lines[j]!);
      j++;
    }
    while (body.length > 0 && isBlank(body[0]!)) body.shift();
    while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
    reflections.push({ date: m[1]!, text: body.join('\n') });
    reflectionInsertAts.push(contentEnd(i + 1, j));
    i = j;
  }

  const progressInsertAt = contentEnd(progressStart, progressEnd);
  const reflectionsInsertAt = contentEnd(reflectionsStart, reflectionsEnd);
  return {
    ok: true,
    doc,
    frontmatter,
    progress,
    reflections,
    reflectionInsertAts,
    currentPage: latest?.page ?? 0,
    lastRead: latest?.date ?? null,
    progressInsertAt,
    reflectionsInsertAt,
    reflectionsHasContent: reflectionsInsertAt > reflectionsStart,
  };
}

/** The canonical new note: LF, final newline, one empty `## Progress` and one empty `## Reflections`. */
export function createBookNote(input: { readonly title: string; readonly author: string; readonly totalPages: number }): string {
  return [
    '---',
    'type: book',
    'status: reading',
    input.author === '' ? 'author:' : `author: ${input.author}`,
    `totalPages: ${input.totalPages}`,
    '---',
    `# ${input.title}`,
    '',
    PROGRESS_HEADING,
    '',
    REFLECTIONS_HEADING,
    '',
  ].join('\n');
}

/** Append exactly one `- <date>: p. N` line at the end of `## Progress`. */
export function appendProgress(source: string, entry: { readonly date: string; readonly page: number }): MutationOk<BookEffect> | Refusal {
  if (!isDate(entry.date) || !Number.isInteger(entry.page)) return refuse('invalid', 'LogReading needs a YYYY-MM-DD date and a whole page number');
  const parsed = parseBookNote(source);
  if (!parsed.ok) return parsed;
  if (parsed.frontmatter.totalPages === null) return shape();
  if (!(entry.page > parsed.currentPage && entry.page <= parsed.frontmatter.totalPages)) {
    return refuse('refused:book-page-invalid', `Page must be past ${parsed.currentPage} and at most ${parsed.frontmatter.totalPages}`);
  }
  const lineText = `- ${entry.date}: p. ${entry.page}`;
  const lines = [...parsed.doc.lines];
  lines.splice(parsed.progressInsertAt, 0, lineText);
  return { ok: true, text: joinDoc(parsed.doc, lines), effect: { kind: 'book', op: 'logged', date: entry.date, lineText } };
}

/** Append `### <date>` plus the reflection text (verbatim) at the end of `## Reflections`; same-day entries stay separate. */
export function appendReflection(source: string, entry: { readonly date: string; readonly text: string }): MutationOk<BookEffect> | Refusal {
  if (!isDate(entry.date)) return refuse('invalid', 'SaveReflection needs a YYYY-MM-DD date');
  const textLines = entry.text.split(/\r\n|\r|\n/);
  if (textLines.every((line) => isBlank(line))) return refuse('refused:book-reflection-empty', 'Write something in the reflection first');
  if (textLines.some((line) => /^ {0,3}#{1,3}(\s|$)/.test(line))) return refuse('invalid', 'A reflection cannot contain heading lines (#, ## or ###)');
  const parsed = parseBookNote(source);
  if (!parsed.ok) return parsed;
  const heading = `### ${entry.date}`;
  const inserted = parsed.reflectionsHasContent ? ['', heading, ...textLines] : [heading, ...textLines];
  const lines = [...parsed.doc.lines];
  lines.splice(parsed.reflectionsInsertAt, 0, ...inserted);
  return { ok: true, text: joinDoc(parsed.doc, lines), effect: { kind: 'book', op: 'reflected', date: entry.date, lineText: heading } };
}

/** ADR-0063: append only within the selected dated reflection; ordinal is 1-based for that date. */
export function appendFollowUp(source: string, entry: { readonly date: string; readonly ordinal: number; readonly question: string; readonly answer: string }): MutationOk<BookEffect> | Refusal {
  if (!isDate(entry.date) || !Number.isInteger(entry.ordinal) || entry.ordinal < 1) return refuse('invalid', 'SaveFollowUp needs a date and a positive whole ordinal');
  if (!entry.question.trim() || /[\r\n\u2028\u2029#]/.test(entry.question)) return refuse('invalid', 'The AI question must be one nonempty line without #');
  const answerLines = entry.answer.split(/\r\n|\r|\n/);
  if (!entry.answer.trim()) return refuse('refused:book-reflection-empty', 'Write an answer first');
  if (answerLines.some((line) => /^ {0,3}#{1,3}(\s|$)/.test(line))) return refuse('invalid', 'An answer cannot contain heading lines (#, ## or ###)');
  if (answerLines.some((line) => /^ {0,3}(`{3,}|~{3,})/.test(line))) return refuse('invalid', 'An answer cannot contain code-fence lines');
  const parsed = parseBookNote(source);
  if (!parsed.ok) return parsed;
  let ordinal = 0;
  const index = parsed.reflections.findIndex((reflection) => reflection.date === entry.date && ++ordinal === entry.ordinal);
  if (index < 0) return refuse('reflection-not-found', 'That saved reflection was not found');
  const lines = [...parsed.doc.lines];
  lines.splice(parsed.reflectionInsertAts[index]!, 0, '', `> AI question: ${entry.question}`, '', ...answerLines);
  return { ok: true, text: joinDoc(parsed.doc, lines), effect: { kind: 'book', op: 'reflected', date: entry.date, lineText: `### ${entry.date}` } };
}

/** ADR-0025 pattern: the exact inverse only — a byte-identical file restores its parent bytes, anything else refuses. */
export function undoBookEdit(source: string, target: string, parent: string, effect: BookEffect): MutationOk<BookEffect> | Refusal {
  if (source !== target) return refuse('refused:undo-expired', 'Cannot restore the exact previous file; undo it in Obsidian');
  return { ok: true, text: parent, effect: { ...effect, op: 'undone' } };
}
