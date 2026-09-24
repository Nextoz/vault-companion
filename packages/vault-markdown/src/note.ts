import type { NoteInput } from './api.ts';
import { assertContext, sanitizeCaptureText } from './sanitize.ts';
import { assertIsoDate, isWellFormed } from './text.ts';

const TITLE_MAX_CODE_POINTS = 60;
// §4.5 list, plus `%`: docs/vault-contract.md §1 / domain `parseVaultPath` reject any path containing `%`.
const TITLE_FORBIDDEN = /[\\/:*?"<>|#^[\]%]/g;

/** §4.5 title: first non-empty line, sanitised, forbidden chars and leading dots removed, ≤ 60 code points. */
export function noteTitle(text: string): string {
  const first = text
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map(sanitizeCaptureText)
    .find((line) => line !== '');
  let title = (first ?? '').normalize('NFC').replace(TITLE_FORBIDDEN, '');
  title = title.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  const cps = Array.from(title);
  if (cps.length > TITLE_MAX_CODE_POINTS) {
    let cut = cps.slice(0, TITLE_MAX_CODE_POINTS);
    // Word boundary: keep the whole prefix only if the next code point starts a new word.
    if (cps[TITLE_MAX_CODE_POINTS] !== ' ') {
      const lastSpace = cut.lastIndexOf(' ');
      if (lastSpace > 0) cut = cut.slice(0, lastSpace);
    }
    title = cut.join('').trim();
  }
  return title === '' ? 'Note' : title;
}

/** Windows-style case-insensitive comparison key; over-matching only adds a ` (n)` suffix, never overwrites. */
function nameKey(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/**
 * docs/vault-contract.md §4.5. Returns the first free candidate path, where a name is taken when it equals an
 * entry of `existingNames` under casefold + NFC. Candidates: `Inbox/<Title> - <date>.md`, then ` (2)`, ` (3)`…
 * Entries may be bare file names or `Inbox/…` paths.
 */
export function noteFileName(text: string, date: string, existingNames: readonly string[]): string {
  assertIsoDate(date, 'date');
  const taken = new Set(existingNames.map(nameKey));
  const stem = `${noteTitle(text)} - ${date}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.md` : `${stem} (${n}).md`;
    if (!taken.has(nameKey(name))) return `Inbox/${name}`;
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** YAML 1.2 double-quoted scalar: escape `\`, `"` and every non-printable or line-breaking code point. */
export function yamlDoubleQuoted(value: string): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (cp === 0x85) out += '\\N';
    else if (cp === 0x2028) out += '\\L';
    else if (cp === 0x2029) out += '\\P';
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else if (cp === 0xfeff || cp === 0xfffe || cp === 0xffff) out += `\\u${cp.toString(16)}`;
    else out += ch;
  }
  return out + '"';
}

/** Full LF-terminated note file content per §4.5. */
export function renderNote(input: NoteInput): string {
  assertIsoDate(input.date, 'date');
  if (!ISO_INSTANT.test(input.capturedAt)) throw new TypeError('capturedAt must be an ISO-8601 instant with offset');
  if (input.context !== undefined) assertContext(input.context);
  if (!isWellFormed(input.text)) throw new TypeError('note text is not well-formed Unicode');
  if (input.text.includes('\u0000')) throw new TypeError('note text contains NUL');
  const front = [
    '---',
    `date: ${input.date}`,
    `created: ${input.capturedAt}`,
    'type: inbox-note',
    'status: open',
    'source: vault-companion',
    'tags:',
    '  - inbox',
    ...(input.context !== undefined ? [`context: ${yamlDoubleQuoted(input.context)}`] : []),
    '---',
    '',
  ];
  let body = input.text.replace(/\r\n?/g, '\n');
  if (!body.endsWith('\n')) body += '\n';
  return `${front.join('\n')}\n${body}`;
}
