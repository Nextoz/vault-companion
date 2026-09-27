// Inbox note body edit (ADR-0022). The owner's free-form Markdown: BOM and frontmatter stay byte-identical, only the
// body the editor showed is replaced, in the file's own EOL and final-newline state.
import type { Eol, MutationOk, Refusal } from './api.ts';
import { isWellFormed, refuse, splitDoc } from './text.ts';

export interface NoteParts {
  readonly bom: boolean;
  /** The leading `---` … `---` block incl. its line break (as scan.ts: first line, closed), or "". Without BOM. */
  readonly frontmatter: string;
  /** Everything after the frontmatter. */
  readonly body: string;
  readonly eol: Eol;
  readonly finalNewline: boolean;
}

export interface NoteEditEffect {
  readonly kind: 'note-body-replaced';
}

const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
const DELIM = /^---[ \t]*$/;
// Same rule as the task list (vault-contract §2 "Conflict markers").
const CONFLICT_MARKER = /^(?:<{7}(?: |$)|={7}$|>{7}(?: |$)|\|{7}(?: |$))/;

/**
 * Length of the frontmatter block at the start of `s` (no BOM), EOL-agnostic so a read of a mixed-EOL note still
 * splits the same way. 0 when the first line is not `---` or the block is never closed (Obsidian: thematic break).
 */
export function noteFrontmatterLength(s: string): number {
  const lines = s.split('\n');
  const bare = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (lines.length < 2 || !DELIM.test(bare(lines[0]!))) return 0;
  let offset = lines[0]!.length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (DELIM.test(bare(line))) return Math.min(offset + line.length + 1, s.length);
    offset += line.length + 1;
  }
  return 0;
}

export function splitNote(text: string): NoteParts | Refusal {
  const doc = splitDoc(text);
  if ('ok' in doc) return doc;
  const rest = doc.bom ? text.slice(1) : text;
  const n = noteFrontmatterLength(rest);
  return { bom: doc.bom, frontmatter: rest.slice(0, n), body: rest.slice(n), eol: doc.eol, finalNewline: doc.finalNewline };
}

/**
 * The note `text` with its body replaced by `newBody`. Line breaks typed in `newBody` (LF, CRLF or lone CR) become the
 * file's EOL; the file keeps its final-newline state. Refusals: conflict markers, mixed EOL, identical result.
 */
export function editNoteBody(text: string, newBody: string): MutationOk<NoteEditEffect> | Refusal {
  if (!isWellFormed(newBody)) return refuse('refused:encoding', 'The new text is not well-formed Unicode.');
  if (newBody.includes(NUL)) return refuse('invalid', 'The new text contains a NUL character.');
  if (text.split(/\r?\n/).some((l) => CONFLICT_MARKER.test(l))) return refuse('refused:vault-conflict', 'The note contains Git conflict markers.');
  const parts = splitNote(text);
  if ('ok' in parts) return parts;
  const { eol, frontmatter, finalNewline } = parts;
  let body = newBody.replace(/\r\n?/g, '\n').split('\n').join(eol);
  // The final-newline state belongs to the file, never the editor: with one, a single trailing EOL is the file's;
  // without one, the file must not gain a trailing line break.
  if (finalNewline) {
    if (body.endsWith(eol)) body = body.slice(0, -eol.length);
  } else {
    while (body.endsWith(eol)) body = body.slice(0, -eol.length);
  }
  // A frontmatter closed on the last line without a break needs one before any body.
  const sep = body !== '' && frontmatter !== '' && !frontmatter.endsWith('\n') ? eol : '';
  let rest = frontmatter + sep + body;
  if (finalNewline && rest !== '' && (body !== '' || !rest.endsWith(eol))) rest += eol;
  const out = (parts.bom ? BOM : '') + rest;
  if (out === text) return refuse('refused:invalid-edit', 'Nothing to change.');
  return { ok: true, text: out, effect: { kind: 'note-body-replaced' } };
}
