// Byte-faithful line model (docs/vault-contract.md §4 "EOL", "Final newline", "BOM", "Unicode").
// A document is split once into lines without EOL; every mutation edits that array and joins it back with the
// file's own EOL, BOM and final-newline state, so untouched lines are reproduced exactly.
import type { Eol, Refusal, RefusalCode } from './api.ts';

export function refuse(code: RefusalCode, message: string): Refusal {
  return { ok: false, code, message };
}

export interface Doc {
  readonly bom: boolean;
  readonly eol: Eol;
  readonly lines: readonly string[];
  readonly finalNewline: boolean;
}

// A lone surrogate cannot be encoded as UTF-8: the string did not come from a valid UTF-8 decode.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

export function splitDoc(text: string): Doc | Refusal {
  if (!isWellFormed(text)) return refuse('refused:encoding', 'Text is not well-formed Unicode.');
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 13) {
      if (body.charCodeAt(i + 1) !== 10) return refuse('refused:mixed-eol', 'File contains a lone carriage return.');
      crlf++;
      i++;
    } else if (c === 10) {
      lf++;
    }
  }
  if (crlf > 0 && lf > 0) return refuse('refused:mixed-eol', 'File mixes LF and CRLF line endings.');
  const eol: Eol = crlf > 0 ? '\r\n' : '\n';
  if (body === '') return { bom, eol, lines: [], finalNewline: false };
  const lines = body.split(eol);
  const finalNewline = lines[lines.length - 1] === '';
  if (finalNewline) lines.pop();
  return { bom, eol, lines, finalNewline };
}

/** Inverse of `splitDoc` for an edited line array (§4: final-newline state and BOM preserved). */
export function joinDoc(doc: Doc, lines: readonly string[]): string {
  const tail = doc.finalNewline && lines.length > 0 ? doc.eol : '';
  return (doc.bom ? '\uFEFF' : '') + lines.join(doc.eol) + tail;
}

export function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** Leading indentation width in columns (space = 1, tab advances to the next multiple of 4). */
export function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

const LIST_ITEM = /^[ \t>]*(?:[-*+]|[0-9]+[.)])(?:[ \t]|$)/;

export function isListItem(line: string): boolean {
  return LIST_ITEM.test(line);
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(value: string, what: string): void {
  if (!ISO_DATE.test(value)) throw new TypeError(`${what} must be YYYY-MM-DD`);
}
