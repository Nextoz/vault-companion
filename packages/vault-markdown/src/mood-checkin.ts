// Daily-note mood check-in (frontmatter value splice). Pure byte-faithful edits: only the four
// check-in value spans change; the BOM, EOL, final newline and every other line stay identical.
import type { MutationOk, Refusal } from './api.ts';
import { refuse } from './text.ts';
import { splitNote } from './note-edit.ts';

export interface MoodCheckinInput {
  readonly mood: number;
  readonly energy: number;
  readonly sleep: number;
  readonly checkinAt: string;
}

export interface MoodCheckinEffect {
  readonly kind: 'mood-checkin';
}

export interface DailyNoteEffect {
  readonly kind: 'daily-note-rendered';
}

const BOM = '\uFEFF';
const DELIM = /^---[ \t]*$/;
const TARGET_LINE = /^(mood|energy|sleep|checkin_at):(.*)$/;
const TARGET_KEYS = ['mood', 'energy', 'sleep', 'checkin_at'] as const;
type TargetKey = (typeof TARGET_KEYS)[number];

const DATE_PLACEHOLDER = '{{date:YYYY-MM-DD}}';
const PLACEHOLDER = /{{[^{}]*}}/g;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SIGNED_INTEGER = /^[+-]?\d+$/;

function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const midnight = `${value}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(midnight)) && new Date(midnight).toISOString().slice(0, 10) === value;
}

function isValidInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isHalfStep(value: number): boolean {
  return Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
}

function validInput(input: MoodCheckinInput): boolean {
  return (
    Number.isInteger(input.mood) &&
    input.mood >= -3 &&
    input.mood <= 3 &&
    Number.isInteger(input.energy) &&
    input.energy >= -3 &&
    input.energy <= 3 &&
    Number.isFinite(input.sleep) &&
    input.sleep >= 0 &&
    input.sleep <= 24 &&
    isHalfStep(input.sleep) &&
    isValidInstant(input.checkinAt)
  );
}

function unquote(value: string): string | undefined {
  if (value.length < 2) return undefined;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  return undefined;
}

function supportedValue(key: TargetKey, value: string): boolean {
  if (value === '') return true;
  switch (key) {
    case 'mood':
    case 'energy':
      return SIGNED_INTEGER.test(value);
    case 'sleep':
      return NUMBER.test(value);
    case 'checkin_at': {
      const inner = unquote(value) ?? value;
      return TIME.test(inner) || isValidInstant(inner);
    }
  }
}

function writeValue(key: TargetKey, input: MoodCheckinInput): string {
  switch (key) {
    case 'mood':
      return String(input.mood);
    case 'energy':
      return String(input.energy);
    case 'sleep':
      return String(input.sleep);
    case 'checkin_at':
      return input.checkinAt;
  }
}

interface TargetLine {
  readonly key: TargetKey;
  readonly index: number;
  readonly value: string;
}

function findTargets(lines: readonly string[], closeIndex: number): TargetLine[] {
  const targets: TargetLine[] = [];
  for (let i = 1; i < closeIndex; i++) {
    const match = TARGET_LINE.exec(lines[i] ?? '');
    if (!match) continue;
    targets.push({ key: match[1] as TargetKey, index: i, value: match[2] ?? '' });
  }
  return targets;
}

function hasFollowingIndentedLine(index: number, closeIndex: number, lines: readonly string[]): boolean {
  const next = index + 1;
  return next < closeIndex && /^[ \t]/.test(lines[next] ?? '');
}

export function applyMoodCheckin(text: string, input: MoodCheckinInput): MutationOk<MoodCheckinEffect> | Refusal {
  if (!validInput(input)) {
    return refuse('checkin-invalid-input', 'Mood check-in values are invalid.');
  }

  const parts = splitNote(text);
  if ('ok' in parts) return parts;
  if (parts.frontmatter === '') return refuse('no-frontmatter', 'The note has no frontmatter block.');

  const lines = parts.frontmatter.split(parts.eol);
  const closeIndex = lines.findIndex((line, index) => index > 0 && DELIM.test(line));
  if (closeIndex < 0) return refuse('no-frontmatter', 'The frontmatter block is not closed.');
  const targets = findTargets(lines, closeIndex);

  const counts = new Map<TargetKey, number>();
  for (const target of targets) counts.set(target.key, (counts.get(target.key) ?? 0) + 1);
  const ambiguous = TARGET_KEYS.filter((key) => (counts.get(key) ?? 0) > 1);
  if (ambiguous.length > 0) return refuse('checkin-field-ambiguous', `Frontmatter has more than one ${ambiguous[0]} key.`);
  const missing = TARGET_KEYS.filter((key) => (counts.get(key) ?? 0) === 0);
  if (missing.length > 0) return refuse('checkin-field-missing', `Frontmatter is missing the ${missing[0]} key.`);

  for (const target of targets) {
    const value = target.value.trim();
    if (!supportedValue(target.key, value) || hasFollowingIndentedLine(target.index, closeIndex, lines)) {
      return refuse('checkin-field-unsupported', `Unsupported ${target.key} value in frontmatter.`);
    }
  }

  const edited = [...lines];
  for (const target of targets) edited[target.index] = `${target.key}: ${writeValue(target.key, input)}`;
  return {
    ok: true,
    text: (parts.bom ? BOM : '') + edited.join(parts.eol) + parts.body,
    effect: { kind: 'mood-checkin' },
  };
}

interface CheckinParts {
  readonly bom: boolean;
  readonly eol: '\n' | '\r\n';
  readonly lines: readonly string[];
  readonly closeIndex: number;
  readonly targets: readonly TargetLine[];
  readonly body: string;
}

function checkinParts(text: string): CheckinParts | Refusal {
  const parts = splitNote(text);
  if ('ok' in parts) return parts;
  if (parts.frontmatter === '') return refuse('no-frontmatter', 'The note has no frontmatter block.');
  const lines = parts.frontmatter.split(parts.eol);
  const closeIndex = lines.findIndex((line, index) => index > 0 && DELIM.test(line));
  if (closeIndex < 0) return refuse('no-frontmatter', 'The frontmatter block is not closed.');
  return { bom: parts.bom, eol: parts.eol, lines, closeIndex, targets: findTargets(lines, closeIndex), body: parts.body };
}

function targetsByKey(targets: readonly TargetLine[]): Map<TargetKey, TargetLine> | null {
  const map = new Map<TargetKey, TargetLine>();
  for (const target of targets) {
    if (map.has(target.key)) return null;
    map.set(target.key, target);
  }
  return map;
}

/**
 * The exact inverse of `applyMoodCheckin`: restore the four value spans from `previous` while keeping every other
 * byte of the current note. Refuses when one of the four current values no longer matches the applied check-in.
 */
export function revertMoodCheckin(text: string, applied: string, previous: string): MutationOk<MoodCheckinEffect> | Refusal {
  const current = checkinParts(text);
  if ('ok' in current) return current;
  const after = checkinParts(applied);
  if ('ok' in after) return after;
  const before = checkinParts(previous);
  if ('ok' in before) return before;

  const currentTargets = targetsByKey(current.targets);
  const afterTargets = targetsByKey(after.targets);
  const beforeTargets = targetsByKey(before.targets);
  if (currentTargets === null || afterTargets === null || beforeTargets === null) {
    return refuse('checkin-field-ambiguous', 'Frontmatter has more than one check-in key.');
  }

  for (const key of TARGET_KEYS) {
    const currentLine = currentTargets.get(key);
    const afterLine = afterTargets.get(key);
    const beforeLine = beforeTargets.get(key);
    if (!currentLine || !afterLine || !beforeLine) {
      return refuse('checkin-field-missing', `Frontmatter is missing the ${key} key.`);
    }
    if (currentLine.value !== afterLine.value) {
      return refuse('conflict:mood-changed', 'A check-in value changed since the check-in; undo it in Obsidian.');
    }
  }

  const edited = [...current.lines];
  for (const key of TARGET_KEYS) {
    const currentLine = currentTargets.get(key)!;
    const beforeLine = beforeTargets.get(key)!;
    edited[currentLine.index] = before.lines[beforeLine.index]!;
  }
  return {
    ok: true,
    text: (current.bom ? BOM : '') + edited.join(current.eol) + current.body,
    effect: { kind: 'mood-checkin' },
  };
}

export function renderDailyNote(template: string, date: string): MutationOk<DailyNoteEffect> | Refusal {
  if (!isValidDate(date)) return refuse('checkin-invalid-input', 'date must be a valid YYYY-MM-DD date.');
  const placeholders = template.match(PLACEHOLDER) ?? [];
  if (placeholders.some((placeholder) => placeholder !== DATE_PLACEHOLDER)) {
    return refuse('template-unsupported-placeholder', 'Template contains an unsupported placeholder.');
  }
  return {
    ok: true,
    text: template.replaceAll(DATE_PLACEHOLDER, date),
    effect: { kind: 'daily-note-rendered' },
  };
}
