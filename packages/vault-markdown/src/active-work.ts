// ADR-0019: a deliberately small grammar; unrecognised lines are never writable items.
import type { LocatorInput, MutationOk, Refusal } from './api.ts';
import { scanLines } from './scan.ts';
import { isBlank, isListItem, isWellFormed, joinDoc, refuse, splitDoc } from './text.ts';

type Section = 'Now' | 'Parked' | 'Dropped or done';
type Values = { name: string; outcome: string | null; next: string | null; review: string | null; link: string | null };
type Span = { start: number; end: number; valueStart: number; valueEnd: number };
export type ActiveWorkItem = Values & {
  lineIndex: number; lineText: string; section: Section; occurrences: number; needsReview: boolean;
};
export type ActiveWorkChanges = { name?: string | undefined; next?: string | null | undefined; review?: string | null | undefined };
export type ActiveWorkCapture = { name: string; next?: string | undefined; review?: string | undefined; link?: string | undefined };
export type ActiveWorkEffect = {
  kind: 'active-work'; op: 'captured' | 'edited' | 'keep' | 'done' | 'park' | 'drop' | 'undone';
  beforeLineText: string | null; afterLineText: string | null;
};
type Result = MutationOk<ActiveWorkEffect> | Refusal;

function dateOK(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
}
function textOK(s: string, max = 500): boolean {
  return s.length > 0 && s.length <= max && s.trim() === s && isWellFormed(s) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(s);
}

/** Token spans retain every unrequested byte, including spacing around optional fields. */
function itemLine(line: string) {
  const head = /^[-*+] \[ \] \*\*(.+?):\*\*(?= |$)/d.exec(line);
  if (!head || !textOK(head[1]!)) return null;
  const spans: Partial<Record<keyof Values, Span>> = {};
  const name = head.indices![1]!;
  spans.name = { start: name[0], end: name[1], valueStart: name[0], valueEnd: name[1] };
  let end = line.trimEnd().length;
  const values: Values = { name: head[1]!, outcome: null, next: null, review: null, link: null };
  const take = (kind: 'link' | 'review' | 'next', regex: RegExp) => {
    const m = regex.exec(line.slice(head[0].length, end));
    if (!m) return;
    const base = head[0].length;
    const v = m.indices![1]!;
    spans[kind] = { start: base + m.index, end, valueStart: base + v[0], valueEnd: base + v[1] };
    values[kind] = m[1]!;
    end = base + m.index;
  };
  take('link', / +(\[\[[^[\]]+\]\])$/d);
  take('review', / +⏳ (\d{4}-\d{2}-\d{2})$/d);
  take('next', / +Next: (.+?)$/d);
  const outcome = line.slice(head[0].length, end).trim();
  values.outcome = outcome || null;
  // Reserved tokens anywhere outside their own field mean an ambiguous hand edit.
  if ([values.name, values.outcome, values.next].some((v) => v !== null &&
    (!textOK(v, v === values.outcome ? 2000 : 500) || /Next:|⏳|✅|❌|\[\[|\]\]|\*\*|%%|<!--/u.test(v)))) return null;
  if (values.review !== null && !dateOK(values.review)) return null;
  return { values, spans, contentEnd: line.trimEnd().length };
}

export function parseActiveWork(text: string, today: string) {
  const doc = splitDoc(text);
  if ('ok' in doc) return doc;
  const scan = scanLines(doc.lines);
  const sections: { name: string; heading: number; end: number }[] = [];
  for (let i = 0; i < doc.lines.length; i++) {
    const h = scan.visible[i] && /^## (.+)$/.exec(doc.lines[i]!.trim());
    if (h) {
      if (sections.length) sections.at(-1)!.end = i;
      sections.push({ name: h[1]!.trim(), heading: i, end: doc.lines.length });
    }
  }
  let writeBlock: Refusal | null = null;
  if (sections.filter((s) => s.name === 'Now').length !== 1 ||
      ['Parked', 'Dropped or done', 'Rules'].some((name) => sections.filter((s) => s.name === name).length > 1)) {
    writeBlock = refuse('refused:structure', 'Active Work sections are missing or ambiguous.');
  }
  if (doc.lines.some((l) => /^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)/.test(l))) {
    writeBlock = refuse('refused:vault-conflict', 'File contains Git conflict markers.');
  }
  const items: ActiveWorkItem[] = [];
  const unknownNowLines: string[] = [];
  for (const section of sections) {
    if (!['Now', 'Parked', 'Dropped or done'].includes(section.name)) continue;
    for (let i = section.heading + 1; i < section.end; i++) {
      const line = doc.lines[i]!;
      const parsed = scan.visible[i] ? itemLine(line) : null;
      if (parsed) items.push({ ...parsed.values, lineIndex: i, lineText: line, section: section.name as Section,
        occurrences: 0, needsReview: parsed.values.review !== null && parsed.values.review < today });
      else if (section.name === 'Now') unknownNowLines.push(line);
    }
  }
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.lineText, (counts.get(item.lineText) ?? 0) + 1);
  for (const item of items) item.occurrences = counts.get(item.lineText)!;
  return { ok: true as const, doc, scan, sections, items, unknownNowLines, writeBlock };
}
type Parsed = Extract<ReturnType<typeof parseActiveWork>, { ok: true }>;

function resolve(a: Parsed, loc: LocatorInput): ActiveWorkItem | Refusal {
  if (loc.sameRevision) {
    const exact = a.items.find((t) => t.lineIndex === loc.lineIndex && t.lineText === loc.lineText && t.section === 'Now');
    if (exact) return exact;
  }
  if (loc.occurrencesAtRead !== 1) return refuse(loc.sameRevision ? 'conflict:task-changed' : 'conflict:ambiguous', 'The item cannot be identified safely.');
  const matches = a.items.filter((t) => t.lineText === loc.lineText);
  if (matches.length > 1) return refuse('conflict:ambiguous', 'Several identical item lines match.');
  if (matches.length !== 1 || matches[0]!.section !== 'Now') return refuse('conflict:task-changed', 'The item was changed or moved.');
  return matches[0]!;
}
function result(a: Parsed, lines: string[], op: ActiveWorkEffect['op'], before: string | null, after: string | null): Result {
  return { ok: true, text: joinDoc(a.doc, lines), effect: { kind: 'active-work', op, beforeLineText: before, afterLineText: after } };
}

/** Insert after an anchor with capture's single blank after a heading, reusing an existing blank. */
function insert(a: Parsed, lines: string[], heading: number, last: number, line: string): Refusal | null {
  if (!a.scan.cleanAfter[last]) return refuse('refused:structure', 'The insertion point is inside hidden Markdown.');
  if (last === heading) {
    const blank = isBlank(lines[last + 1] ?? 'not blank');
    lines.splice(last + 1 + (blank ? 1 : 0), 0, ...(blank ? [] : ['']), line);
  } else lines.splice(last + 1, 0, line);
  return null;
}

export function captureActiveWork(text: string, input: ActiveWorkCapture): Result {
  const line = `- [ ] **${input.name}:**${input.next !== undefined ? ` Next: ${input.next}` : ''}${input.review !== undefined ? ` ⏳ ${input.review}` : ''}${input.link !== undefined ? ` ${input.link}` : ''}`;
  const p = itemLine(line);
  if (!p || p.values.name !== input.name || p.values.outcome !== null || p.values.next !== (input.next ?? null) ||
      p.values.review !== (input.review ?? null) || p.values.link !== (input.link ?? null) || !textOK(line, 16000)) {
    return refuse('refused:invalid-edit', 'The new item must round-trip without introducing other fields.');
  }
  const visible = scanLines([line]);
  if (!visible.visible[0] || !visible.cleanAfter[0]) return refuse('refused:invalid-edit', 'The item cannot open a Markdown comment.');
  const a = parseActiveWork(text, '0000-01-01');
  if (!a.ok) return a;
  if (a.writeBlock) return a.writeBlock;
  const section = a.sections.find((s) => s.name === 'Now')!;
  const last = a.items.filter((t) => t.section === 'Now').at(-1)?.lineIndex ?? section.heading;
  const lines = [...a.doc.lines];
  const invalid = insert(a, lines, section.heading, last, line);
  return invalid ?? result(a, lines, 'captured', null, line);
}

export function editActiveWork(text: string, locator: LocatorInput, changes: ActiveWorkChanges): Result {
  const invalid = () => refuse('refused:invalid-edit', 'The edited item must round-trip exactly; nothing was written.');
  if ((changes.name !== undefined && !textOK(changes.name)) || (changes.next != null && !textOK(changes.next)) ||
      (changes.review != null && !dateOK(changes.review))) return invalid();
  const a = parseActiveWork(text, '0000-01-01');
  if (!a.ok) return a;
  if (a.writeBlock) return a.writeBlock;
  const t = resolve(a, locator);
  if ('ok' in t) return t;
  const p = itemLine(t.lineText)!;
  const expected = { ...p.values };
  const edits: { start: number; end: number; text: string }[] = [];
  for (const kind of ['name', 'next', 'review'] as const) {
    const value = changes[kind];
    if (value === undefined) continue;
    if (kind === 'name') expected.name = value!;
    else expected[kind] = value;
    const span = p.spans[kind];
    if (span) edits.push(value === null ? { start: span.start, end: span.end, text: '' } :
      { start: span.valueStart, end: span.valueEnd, text: value });
    else if (value !== null) {
      const at = kind === 'next' ? (p.spans.review?.start ?? p.spans.link?.start ?? p.contentEnd) :
        (p.spans.link?.start ?? p.contentEnd);
      edits.push({ start: at, end: at, text: ` ${kind === 'next' ? 'Next:' : '⏳'} ${value}` });
    }
  }
  let line = t.lineText;
  // Later-added fields at the same offset are applied first, keeping Next before review.
  for (const e of edits.reverse().sort((x, y) => y.start - x.start || y.end - x.end)) line = line.slice(0, e.start) + e.text + line.slice(e.end);
  const after = itemLine(line);
  if (!after || JSON.stringify(after.values) !== JSON.stringify(expected) || line === t.lineText) return invalid();
  const lines = [...a.doc.lines];
  lines[t.lineIndex] = line;
  return result(a, lines, 'edited', t.lineText, line);
}

export function reviewActiveWork(text: string, locator: LocatorInput, action: 'keep' | 'done' | 'park' | 'drop', today: string, reason?: string): Result {
  if (!dateOK(today) || !['keep', 'done', 'park', 'drop'].includes(action) ||
      (action === 'drop' && (reason === undefined || !textOK(reason, 200)))) return refuse('invalid', 'Invalid review date, action or reason.');
  if (action === 'keep') {
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 7);
    const r = editActiveWork(text, locator, { review: day.toISOString().slice(0, 10) });
    return r.ok ? { ...r, effect: { ...r.effect, op: 'keep' } } : r;
  }
  const a = parseActiveWork(text, today);
  if (!a.ok) return a;
  if (a.writeBlock) return a.writeBlock;
  const t = resolve(a, locator);
  if ('ok' in t) return t;
  const line = action === 'park' ? t.lineText : action === 'done' ?
    `${t.lineText.replace('[ ]', '[x]')} ✅ ${today}` : `${t.lineText} ❌ ${today} ${reason!}`;
  const targetName = action === 'park' ? 'Parked' : 'Dropped or done';
  const section = a.sections.find((s) => s.name === targetName);
  const lines = [...a.doc.lines];
  // Insert first; remove at its adjusted index, so target sections may precede Now.
  let at: number;
  const oldLength = lines.length;
  if (section) {
    let last = section.heading;
    for (let i = section.heading + 1; i < section.end; i++) if (a.scan.visible[i] && isListItem(lines[i]!)) last = i;
    at = last + 1;
    const invalid = insert(a, lines, section.heading, last, line);
    if (invalid) return invalid;
  } else {
    at = a.sections.find((s) => s.name === 'Rules')?.heading ?? lines.length;
    if (at > 0 && !a.scan.cleanAfter[at - 1]) return refuse('refused:structure', 'Cannot create a section inside hidden Markdown.');
    lines.splice(at, 0, ...(at > 0 && !isBlank(lines[at - 1]!) ? [''] : []), `## ${targetName}`, '', line,
      ...(at < lines.length || a.doc.finalNewline ? [''] : []));
  }
  lines.splice(t.lineIndex + (at <= t.lineIndex ? lines.length - oldLength : 0), 1);
  return result(a, lines, action, t.lineText, line);
}

/** Only call with target/parent text verified from Git by the domain's ADR-0013 replay. */
export function undoActiveWork(text: string, targetText: string, parentText: string, effect: ActiveWorkEffect): Result {
  if (text !== targetText) return refuse('refused:undo-expired', 'The file changed after this review; undo it in Obsidian.');
  return { ok: true, text: parentText, effect: { kind: 'active-work', op: 'undone', beforeLineText: effect.afterLineText, afterLineText: effect.beforeLineText } };
}
