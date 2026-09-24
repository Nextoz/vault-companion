import type { NoteInput } from './api.ts';

/**
 * docs/vault-contract.md §4.5. Returns the first free candidate path, where a name is taken when it equals an
 * entry of `existingNames` under casefold + NFC. Candidates: `Inbox/<Title> - <date>.md`, then ` (2)`, ` (3)`…
 */
export function noteFileName(_text: string, _date: string, _existingNames: readonly string[]): string {
  throw new Error('not implemented');
}

/** Full LF-terminated note file content per §4.5. */
export function renderNote(_input: NoteInput): string {
  throw new Error('not implemented');
}
