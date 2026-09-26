// Display helpers. Output is always rendered as React text nodes.
import type { ErrorCode } from '@vault-companion/contracts';

/** `[[target|alias]]` → `alias`, `[[target]]` → `target` (no note reading in the first shell). */
export function plainWikilinks(s: string): string {
  return s.replace(/\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
    (alias ?? target).trim(),
  );
}

export type Segment = { kind: 'text'; text: string } | { kind: 'link'; text: string; linkIndex: number };

/**
 * A task description split into text and openable wikilinks. Link numbering mirrors the kernel (`[[…]]`, target = text
 * before `|`/`#`, empty targets skipped), and a link is openable only when its target equals `links[i]` from the read —
 * otherwise it is plain text, so a tap can never ask the server for a different link than the one shown.
 */
export function taskSegments(description: string, links: readonly string[]): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let index = 0;
  for (const m of description.matchAll(/\[\[([^[\]]+?)\]\]/g)) {
    if (m.index > last) out.push({ kind: 'text', text: description.slice(last, m.index) });
    last = m.index + m[0].length;
    const inner = m[1]!;
    const target = inner.split(/[|#]/)[0]!.trim();
    const bar = inner.indexOf('|');
    const text = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
    if (target === '') {
      out.push({ kind: 'text', text: plainWikilinks(m[0]) });
      continue;
    }
    const linkIndex = index++;
    out.push(links[linkIndex] === target ? { kind: 'link', text, linkIndex } : { kind: 'text', text });
  }
  if (last < description.length) out.push({ kind: 'text', text: description.slice(last) });
  return out;
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
