import { isWellFormed } from './text.ts';

// C0, DEL, C1 (includes U+0085 NEL) and the Unicode line/paragraph separators.
const CONTROL_OR_SEPARATOR = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * docs/vault-contract.md §4.3: every line/paragraph separator and control char → space, whitespace runs
 * collapse to one space, trimmed. The result is always a single line.
 */
export function sanitizeCaptureText(text: string): string {
  return text.replace(CONTROL_OR_SEPARATOR, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * `context` is validated upstream (contracts); the kernel re-checks because it is spliced into a single
 * vault line or a YAML scalar: it must be `[[wikilink]]` or an http(s) URL with no control/separator chars.
 */
export function assertContext(context: string): void {
  const hasControl = new RegExp(CONTROL_OR_SEPARATOR.source).test(context);
  const shape = /^\[\[[^[\]]+\]\]$/.test(context) || /^https?:\/\/\S+$/.test(context);
  if (hasControl || !shape || !isWellFormed(context)) throw new TypeError('context must be a [[wikilink]] or http(s) URL');
}
