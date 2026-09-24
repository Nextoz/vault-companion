// Display helpers. Output is always rendered as React text nodes.
import type { ErrorCode } from '@vault-companion/contracts';

/** `[[target|alias]]` → `alias`, `[[target]]` → `target` (no note reading in the first shell). */
export function plainWikilinks(s: string): string {
  return s.replace(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
    (alias ?? target).trim(),
  );
}

const READ_ONLY: Partial<Record<ErrorCode, string>> = {
  'refused:recurring': 'Recurring — complete in Obsidian',
  'refused:on-completion': 'Has an on-completion rule — complete in Obsidian',
  'refused:unsupported-status': 'Status not supported here',
  'refused:duplicate-field': 'Ambiguous fields — edit in Obsidian',
  'refused:structure': 'File layout not supported',
  'refused:vault-conflict': 'File has a sync conflict',
  'conflict:ambiguous': 'Duplicate task — complete in Obsidian',
};

export const readOnlyText = (code: ErrorCode): string => READ_ONLY[code] ?? 'Read-only in this app';
