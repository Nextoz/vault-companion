// Trailing-field parsing, mirroring Obsidian Tasks 8.0.0 (docs/vault-contract.md §2 "Trailing fields"):
// strip a trailing block ID, then repeatedly strip one field or tag from the END of the body until nothing
// matches. Markers that are not trailing stay in the description and are never interpreted.
import type { Priority } from './api.ts';

export type FieldKind =
  | 'priority'
  | 'due'
  | 'scheduled'
  | 'start'
  | 'created'
  | 'done'
  | 'cancelled'
  | 'recurrence'
  | 'id'
  | 'dependsOn'
  | 'onCompletion';

const DATE = '(\\d{4}-\\d{2}-\\d{2})';
const field = (emoji: string, value: string): RegExp => new RegExp(`${emoji}\\uFE0F? *${value}$`, 'u');

const FIELD_PATTERNS: readonly (readonly [FieldKind, RegExp])[] = [
  ['priority', /([🔺⏫🔼🔽⏬])\uFE0F?$/u],
  ['due', field('📅', DATE)],
  ['scheduled', field('⏳', DATE)],
  ['start', field('🛫', DATE)],
  ['created', field('➕', DATE)],
  ['done', field('✅', DATE)],
  ['cancelled', field('❌', DATE)],
  ['recurrence', field('🔁', '([a-zA-Z0-9, !]+)')],
  ['id', field('🆔', '([a-zA-Z0-9_-]+)')],
  ['dependsOn', field('⛔', '([a-zA-Z0-9_-]+(?: *, *[a-zA-Z0-9_-]+)*)')],
  ['onCompletion', field('🏁', '([a-zA-Z]+)')],
];

export const PRIORITY_BY_EMOJI: Readonly<Record<string, Priority>> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};

export const EMOJI_BY_PRIORITY: Readonly<Record<Priority, string>> = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬',
};

const TAG_CHAR = '[^\\s!@#$%^&*(),.?":{}|<>\\[\\]\\\\`\'~+=;]';
const TRAILING_TAG = new RegExp(`(?:^|\\s)(#${TAG_CHAR}+)$`, 'u');
const ANY_TAG = new RegExp(`(?:^|\\s)(#${TAG_CHAR}+)`, 'gu');
const BLOCK_ID = / \^([A-Za-z0-9-]+)$/;
const WIKILINK = /\[\[([^[\]]+?)\]\]/g;

export interface TaskFields {
  readonly description: string;
  readonly values: Readonly<Partial<Record<FieldKind, string>>>;
  /** A field kind occurred more than once among the trailing fields. */
  readonly duplicateField: boolean;
  readonly blockId: string | null;
  readonly tags: readonly string[];
  readonly links: readonly string[];
}

/** `body` = the task line after `[c]` and its following spaces. */
export function parseTaskBody(body: string): TaskFields {
  let rest = body.trimEnd();
  let blockId: string | null = null;
  const b = BLOCK_ID.exec(rest);
  if (b) {
    blockId = b[1]!;
    rest = rest.slice(0, b.index).trimEnd();
  }
  const values: Partial<Record<FieldKind, string>> = {};
  let duplicateField = false;
  const trailingTags: string[] = [];
  for (;;) {
    let matched = false;
    for (const [kind, re] of FIELD_PATTERNS) {
      const m = re.exec(rest);
      if (!m) continue;
      if (kind in values) duplicateField = true;
      else values[kind] = m[1]!;
      rest = rest.slice(0, m.index).trimEnd();
      matched = true;
      break;
    }
    if (!matched) {
      const t = TRAILING_TAG.exec(rest);
      if (t) {
        trailingTags.unshift(t[1]!);
        rest = rest.slice(0, t.index).trimEnd();
        matched = true;
      }
    }
    if (!matched) break;
  }
  const description = rest.trim();
  const tags = [...[...description.matchAll(ANY_TAG)].map((m) => m[1]!), ...trailingTags];
  const links: string[] = [];
  for (const m of body.matchAll(WIKILINK)) {
    const target = m[1]!.split(/[|#]/)[0]!.trim();
    if (target !== '') links.push(target);
  }
  return { description, values, duplicateField, blockId, tags, links };
}
