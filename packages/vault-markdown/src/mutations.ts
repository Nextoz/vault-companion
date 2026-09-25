import type { CaptureTaskInput, CompleteEffect, LocatorInput, MutationOk, Refusal, UndoInput } from './api.ts';
import { EMOJI_BY_PRIORITY } from './fields.ts';
import { isValidContext, sanitizeCaptureText } from './sanitize.ts';
import { analyse, analyseDoc, captureInsertionPoint, matchTaskLine, type Analysis, type IndexedTask } from './todo-list.ts';
import { ISO_DATE, indentWidth, isBlank, isListItem, isWellFormed, joinDoc, refuse, type Doc } from './text.ts';

/** Thrown when a post-condition of a splice does not hold: a kernel bug, never written to the vault. */
export class KernelInvariantError extends Error {
  override readonly name = 'KernelInvariantError';
}

function invariant(condition: boolean, what: string): asserts condition {
  if (!condition) throw new KernelInvariantError(what);
}

/** docs/vault-contract.md §3: revision-validated exact-content locator (ADR-0003, review F2). */
function resolve(a: Analysis, loc: LocatorInput): IndexedTask | Refusal {
  if (loc.sameRevision) {
    const exact = a.tasks.find((t) => t.lineIndex === loc.lineIndex);
    if (exact && exact.lineText === loc.lineText) return exact;
  }
  if (loc.occurrencesAtRead !== 1) {
    return loc.sameRevision
      ? refuse('conflict:task-changed', 'The task is no longer at the line it was read from.')
      : refuse('conflict:ambiguous', 'The task had identical twins when read and the file has changed since.');
  }
  const matches = a.tasks.filter((t) => t.lineText === loc.lineText);
  if (matches.length === 0) return refuse('conflict:task-changed', 'The task line was changed or removed.');
  if (matches.length > 1) return refuse('conflict:ambiguous', 'Several identical task lines match.');
  return matches[0]!;
}

/** §4.1 step 1: `[ ]` → `[x]`, ` ✅ <date>` after the last field and before a trailing block ID. */
function completedLine(t: IndexedTask, doneDate: string): string {
  const line = t.lineText;
  const at = t.match.checkboxOffset + 1;
  invariant(line[at] === ' ', 'checkbox is open');
  const checked = line.slice(0, at) + 'x' + line.slice(at + 1);
  // Only spaces and tabs are trimmed (R13). Other trailing whitespace after a block ID (NBSP) stays with the ID,
  // which keeps it trailing as the parser (`trimEnd`) and Obsidian read it.
  const trimmed = checked.replace(/[ \t]+$/, '');
  const blockId = / \^[A-Za-z0-9-]+\s*$/u.exec(trimmed);
  const head = (blockId ? trimmed.slice(0, blockId.index) : trimmed).replace(/[ \t]+$/, '');
  return `${head} ✅ ${doneDate}${blockId ? blockId[0] : ''}`;
}

/** docs/vault-contract.md §3 + §4.1. `doneDate` is YYYY-MM-DD. */
export function completeTask(text: string, locator: LocatorInput, doneDate: string): MutationOk<CompleteEffect> | Refusal {
  if (!ISO_DATE.test(doneDate)) return refuse('invalid', 'doneDate must be YYYY-MM-DD.');
  const a = analyse(text);
  if ('ok' in a) return a;
  if (a.writeBlock) return a.writeBlock;
  const t = resolve(a, locator);
  if ('ok' in t) return t;
  if (t.parsed.status === 'done' || t.parsed.status === 'cancelled') {
    return refuse('refused:already-completed', 'The task is already completed.');
  }
  if (t.parsed.readOnlyReason) return refuse(t.parsed.readOnlyReason, 'The app does not complete this kind of task.');

  const lines = a.doc.lines;
  const i = t.lineIndex;
  const n = t.blockEnd - i;
  const completed = completedLine(t, doneDate);
  const base = { completedLineText: completed, openLineText: t.lineText, removedAt: i, blockLineCount: n, doneDate };

  if (t.section === 'done') {
    const out = [...lines];
    out[i] = completed;
    const effect: CompleteEffect = {
      ...base,
      insertedAt: i,
      blankInserted: false,
      anchorBefore: '',
      blankLinesAfterAnchor: 0,
      completedInPlace: true,
    };
    return verifiedCompletion(a.doc, out, effect);
  }

  const open = a.open!;
  const done = a.done!;
  let anchor = i - 1;
  while (anchor > open.heading && isBlank(lines[anchor]!)) anchor--;

  // §4.1 step 3: before the first top-level task line in Done; else after Done's last non-blank line.
  let target = -1;
  let blankBefore = false;
  for (let j = done.heading + 1; j < done.end; j++) {
    if (a.scan.visible[j] && matchTaskLine(lines[j]!)?.indent === '') {
      target = j;
      break;
    }
  }
  if (target < 0) {
    let last = done.end - 1;
    while (last > done.heading && isBlank(lines[last]!)) last--;
    target = last + 1;
    blankBefore = !isListItem(lines[last]!);
  }
  // R6: Done must not leave a fence/comment open at the insertion point (the block would land inside it).
  if (a.scan.cleanAfter[target - 1] !== true) return refuse('refused:structure', '"## Done" ends inside a fence or comment.');

  const inserted = [...(blankBefore ? [''] : []), completed, ...lines.slice(i + 1, t.blockEnd)];
  const out = [...lines];
  let insertedAt: number;
  if (target > i) {
    out.splice(target, 0, ...inserted);
    out.splice(i, n);
    insertedAt = target - n + (blankBefore ? 1 : 0);
  } else {
    out.splice(i, n);
    out.splice(target, 0, ...inserted);
    insertedAt = target + (blankBefore ? 1 : 0);
  }
  const effect: CompleteEffect = {
    ...base,
    insertedAt,
    blankInserted: blankBefore,
    anchorBefore: lines[anchor]!,
    blankLinesAfterAnchor: i - anchor - 1,
    completedInPlace: false,
  };
  return verifiedCompletion(a.doc, out, effect);
}

function verifiedCompletion(doc: Doc, out: string[], effect: CompleteEffect): MutationOk<CompleteEffect> {
  const after = analyseDoc({ ...doc, lines: out });
  const moved = after.tasks.find((t) => t.lineIndex === effect.insertedAt);
  invariant(after.writeBlock === null, 'completion keeps the file writable');
  invariant(moved?.lineText === effect.completedLineText && moved.section === 'done', 'completed task lands in Done');
  invariant(moved.parsed.status === 'done' && moved.parsed.done === effect.doneDate, 'completed task parses as done');
  invariant(moved.blockEnd - moved.lineIndex === effect.blockLineCount, 'block moved intact');
  return { ok: true, text: joinDoc(doc, out), effect };
}

/** docs/vault-contract.md §4.2 (exact inverse when unchanged, semantic inverse otherwise). */
export function undoCompleteTask(text: string, input: UndoInput): MutationOk<{ openLineText: string }> | Refusal {
  const c = input.completion;
  const a = analyse(text);
  if ('ok' in a) return a;
  if (a.writeBlock) return a.writeBlock;
  if (input.unchangedSinceCompletion) {
    const exact = exactInverse(text, a, c);
    if (exact) return exact;
  }
  return semanticInverse(a, c);
}

/** §4.2 step 1 on its own: the verified original, or `null` when the exact inverse declines (tests, not index.ts). */
export function exactUndo(text: string, completion: CompleteEffect): MutationOk<{ openLineText: string }> | null {
  const a = analyse(text);
  if ('ok' in a || a.writeBlock) return null;
  return exactInverse(text, a, completion);
}

/**
 * §4.2 step 1. A candidate original is accepted only if completing it again reproduces `text` byte for byte
 * **and** the whole recorded effect, and only if it is the unique such candidate (review A1/R1: completion is not
 * injective — with Done above Open a wrong candidate re-completes in place to the same bytes).
 */
function exactInverse(text: string, a: Analysis, c: CompleteEffect): MutationOk<{ openLineText: string }> | null {
  const lines = a.doc.lines;
  if (lines[c.insertedAt] !== c.completedLineText) return null;
  // "x\n" is both [x] with a final newline and [x, ""] without one. Removing the last line of a file without a
  // final newline (F16) yields the first reading on re-parse, but the original needs the second.
  const readings: Doc[] = [a.doc];
  if (a.doc.finalNewline) readings.push({ ...a.doc, lines: [...lines, ''], finalNewline: false });
  const originals = new Set<string>();
  for (const doc of readings) {
    const out = [...doc.lines];
    if (c.completedInPlace) {
      out[c.insertedAt] = c.openLineText;
    } else {
      const blank = c.blankInserted ? 1 : 0;
      if (blank === 1 && doc.lines[c.insertedAt - 1] !== '') continue;
      const children = doc.lines.slice(c.insertedAt + 1, c.insertedAt + c.blockLineCount);
      out.splice(c.insertedAt - blank, c.blockLineCount + blank);
      if (c.removedAt > out.length) continue;
      out.splice(c.removedAt, 0, c.openLineText, ...children);
    }
    const original = joinDoc(doc, out);
    const again = completeTask(
      original,
      { lineIndex: c.removedAt, lineText: c.openLineText, occurrencesAtRead: 1, sameRevision: true },
      c.doneDate,
    );
    if (again.ok && again.text === text && sameEffect(again.effect, c)) originals.add(original);
  }
  if (originals.size !== 1) return null;
  const [original] = originals;
  return { ok: true, text: original!, effect: { openLineText: c.openLineText } };
}

// Every CompleteEffect field; a new field is a compile error here until it is compared too.
const EFFECT_FIELDS: Record<keyof CompleteEffect, true> = {
  completedLineText: true,
  openLineText: true,
  removedAt: true,
  blockLineCount: true,
  insertedAt: true,
  blankInserted: true,
  anchorBefore: true,
  blankLinesAfterAnchor: true,
  completedInPlace: true,
  doneDate: true,
};

function sameEffect(x: CompleteEffect, y: CompleteEffect): boolean {
  return (Object.keys(EFFECT_FIELDS) as (keyof CompleteEffect)[]).every((k) => x[k] === y[k]);
}

/** §4.2 steps 2–3. */
function semanticInverse(a: Analysis, c: CompleteEffect): MutationOk<{ openLineText: string }> | Refusal {
  const matches = a.tasks.filter((t) => t.section === 'done' && t.lineText === c.completedLineText);
  if (matches.length === 0) return refuse('conflict:task-changed', 'The completed task line was changed or removed.');
  if (matches.length > 1) return refuse('conflict:ambiguous', 'Several identical completed task lines match.');
  const t = matches[0]!;
  const lines = a.doc.lines;

  if (c.completedInPlace) {
    const out = [...lines];
    out[t.lineIndex] = c.openLineText;
    return verifiedUndo(a, t, out, t.lineIndex, c, 'done');
  }

  if (a.scan.cleanAfter[t.blockEnd - 1] !== true) return refuse('refused:structure', 'The task block cannot be moved safely.');
  const block = [c.openLineText, ...lines.slice(t.lineIndex + 1, t.blockEnd)];
  // R7: drop the blank completion inserted into an empty Done, if it is still blank and Done has nothing else.
  const done = a.done!;
  const doneOtherwiseEmpty = lines.every((line, j) => j <= done.heading || j >= done.end || (j >= t.lineIndex && j < t.blockEnd) || isBlank(line));
  // Line above the block is the heading (not blank) when the desktop already deleted the blank.
  const residue = c.blankInserted && isBlank(lines[t.lineIndex - 1]!) && doneOtherwiseEmpty ? 1 : 0;
  const rest = [...lines.slice(0, t.lineIndex - residue), ...lines.slice(t.blockEnd)];
  const mid = analyseDoc({ ...a.doc, lines: rest });
  if (mid.writeBlock) return mid.writeBlock;
  const open = mid.open!;

  let at = -1;
  if (c.anchorBefore !== '' && !isBlank(c.anchorBefore)) {
    const anchors: number[] = [];
    // R6: only visible lines count (a copy inside a fence or comment is not the anchor).
    for (let j = open.heading; j < open.end; j++) if (mid.scan.visible[j] && rest[j] === c.anchorBefore) anchors.push(j);
    if (anchors.length === 1) {
      const k = anchors[0]!;
      let blanks = 0;
      while (k + 1 + blanks < open.end && isBlank(rest[k + 1 + blanks]!)) blanks++;
      // Keep the recorded blank-line count; never add blank lines the file no longer has.
      at = k + 1 + Math.min(blanks, c.blankLinesAfterAnchor);
    }
  }
  let blankBefore = false;
  if (at < 0) {
    if (mid.openHasSubheading) return refuse('refused:structure', '"## Open" contains subheadings.');
    const point = captureInsertionPoint(rest, open);
    if ('ok' in point) return point;
    ({ at, blankBefore } = point);
  }
  // No adoption (A5/R2): an indented next non-blank line would become a child of the restored task.
  let next = at;
  while (next < rest.length && isBlank(rest[next]!)) next++;
  if (next < rest.length && indentWidth(rest[next]!) > 0) {
    return refuse('refused:structure', 'The restored task would adopt the indented line that follows it.');
  }
  const out = [...rest.slice(0, at), ...(blankBefore ? [''] : []), ...block, ...rest.slice(at)];
  return verifiedUndo(a, t, out, at + (blankBefore ? 1 : 0), c, 'open');
}

/** `before`/`completed`: the analysed current file and the completed task being reverted. */
function verifiedUndo(
  before: Analysis,
  completed: IndexedTask,
  out: string[],
  at: number,
  c: CompleteEffect,
  section: 'open' | 'done',
): MutationOk<{ openLineText: string }> {
  const after = analyseDoc({ ...before.doc, lines: out });
  const restored = after.tasks.find((t) => t.lineIndex === at);
  invariant(after.writeBlock === null, 'undo keeps the file writable');
  invariant(restored?.lineText === c.openLineText && restored.section === section, 'task restored');
  invariant(restored.parsed.status === 'open', 'restored task parses as open');
  const size = (t: IndexedTask): number => t.blockEnd - t.lineIndex;
  invariant(size(restored) === size(completed), 'restored task has exactly its completed block');
  const others = (tasks: readonly IndexedTask[], skip: IndexedTask): string[] =>
    tasks.filter((t) => t !== skip).map((t) => `${size(t)} ${t.lineText}`);
  invariant(sameArray(others(after.tasks, restored), others(before.tasks, completed)), 'every other task keeps its block');
  return { ok: true, text: joinDoc(before.doc, out), effect: { openLineText: c.openLineText } };
}

/** docs/vault-contract.md §4.3 line format; `text` already sanitised and non-empty. */
function captureLine(text: string, input: CaptureTaskInput): string {
  let line = `- [ ] ${text}`;
  if (input.context !== undefined) line += ` ${input.context}`;
  line += ' #todo';
  if (input.priority !== undefined) line += ` ${EMOJI_BY_PRIORITY[input.priority]}`;
  if (input.due !== undefined) line += ` 📅 ${input.due}`;
  return `${line} ➕ ${input.createdDate}`;
}

/** docs/vault-contract.md §4.3–4.4. */
export function captureTask(text: string, input: CaptureTaskInput): MutationOk<{ lineText: string }> | Refusal {
  if (!ISO_DATE.test(input.createdDate)) return refuse('invalid', 'createdDate must be YYYY-MM-DD.');
  if (input.due !== undefined && !ISO_DATE.test(input.due)) return refuse('invalid', 'due must be YYYY-MM-DD.');
  if (input.context !== undefined && !isValidContext(input.context)) {
    return refuse('invalid', 'context must be a [[wikilink]] or http(s) URL.');
  }
  if (!isWellFormed(input.text)) return refuse('refused:encoding', 'Capture text is not well-formed Unicode.');
  const clean = sanitizeCaptureText(input.text);
  if (clean === '') return refuse('invalid', 'Capture text is empty.');
  const lineText = captureLine(clean, input);

  const a = analyse(text);
  if ('ok' in a) return a;
  if (a.writeBlock) return a.writeBlock;
  if (a.openHasSubheading) return refuse('refused:structure', '"## Open" contains subheadings.');
  const lines = a.doc.lines;
  const point = captureInsertionPoint(lines, a.open!);
  if ('ok' in point) return point;
  const inserted = point.blankBefore ? ['', lineText] : [lineText];
  const out = [...lines.slice(0, point.at), ...inserted, ...lines.slice(point.at)];
  const at = point.at + inserted.length - 1;

  const after = analyseDoc({ ...a.doc, lines: out });
  // The new line must not change how any other line is read (e.g. an unclosed `%%` or `<!--` in the text
  // would hide the rest of the file from Obsidian).
  const shifted = (xs: readonly boolean[]): boolean[] => [...xs.slice(0, point.at), ...xs.slice(at + 1)];
  const sameReading =
    after.scan.visible[at] === true &&
    after.scan.cleanAfter[at] === true &&
    sameArray(shifted(after.scan.visible), a.scan.visible) &&
    sameArray(shifted(after.scan.cleanAfter), a.scan.cleanAfter);
  if (!sameReading) return refuse('refused:structure', 'Capture text would change how the rest of the file is read.');
  const captured = after.tasks.find((t) => t.lineIndex === at);
  invariant(after.writeBlock === null, 'capture keeps the file writable');
  invariant(captured?.lineText === lineText && captured.section === 'open', 'captured task lands in Open');
  invariant(captured.parsed.status === 'open' && after.tasks.length === a.tasks.length + 1, 'captured task parses as open');
  invariant(captured.parsed.blockLineCount === 1, 'captured task adopts no following line');
  return { ok: true, text: joinDoc(a.doc, out), effect: { lineText } };
}

function sameArray<T>(x: readonly T[], y: readonly T[]): boolean {
  return x.length === y.length && x.every((v, k) => v === y[k]);
}
