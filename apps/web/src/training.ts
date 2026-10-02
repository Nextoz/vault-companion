import type { TrainingRow } from '@vault-companion/contracts';

export function numberWithUnit(value: string, unit: string): number | null {
  const match = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:${unit})?$`).exec(value.trim());
  return match ? Number(match[1]) : null;
}
function unit(value: string, suffix: string): string {
  return value && numberWithUnit(value, suffix) !== null ? `${numberWithUnit(value, suffix)} ${suffix}` : value;
}
export function trainingSummary(row: TrainingRow): string {
  if (row.type === 'Run') {
    const distance = numberWithUnit(row.distance, 'km');
    const duration = numberWithUnit(row.duration, 'min');
    const seconds = distance && duration ? Math.round(duration * 60 / distance) : null;
    const pace = seconds === null ? '' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} /km`;
    return [unit(row.distance, 'km'), unit(row.duration, 'min'), pace].filter(Boolean).join(' · ');
  }
  return [row.split, unit(row.duration, 'min'), unit(row.weight, 'kg'), row.distance].filter(Boolean).join(' · ');
}

/**
 * Stable React keys: row content plus its occurrence number, so a session prepended by a refresh never makes an
 * existing row's element (e.g. an expanded note) show another session.
 */
export function trainingRowKeys(rows: readonly TrainingRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const content = JSON.stringify([row.date, row.time, row.type, row.distance, row.duration, row.weight, row.split, row.note]);
    const n = (seen.get(content) ?? 0) + 1;
    seen.set(content, n);
    return `${content}#${n}`;
  });
}

/** datetime-local displays device-local time; the command always carries its explicit offset. */
export function trainingLocalTime(now = new Date()): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * B11 (ADR-0041): class names already logged in `Group: <name>` split cells, most recent first (the rows are
 * newest-first), case-sensitive and distinct, at most six. A legacy bare `Group: ` cell suggests nothing.
 */
export function groupClassSuggestions(rows: readonly TrainingRow[], limit = 6): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows) {
    if (!row.split.startsWith('Group: ')) continue;
    const name = row.split.slice('Group: '.length);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length === limit) break;
  }
  return names;
}

/** What the training sheet's controlled inputs hold; every field is a string, so an unparseable cell stays empty. */
export interface TrainingDraft {
  type: 'Gym' | 'Run';
  /** `YYYY-MM-DDTHH:MM` for the datetime-local input; empty means the sheet keeps its own default (now). */
  when: string;
  distance: string;
  duration: string;
  weight: string;
  split: 'Bicep' | 'Tricep' | 'Legs' | 'Group';
  className: string;
  note: string;
}

/** Inverse of the writer's cell escaping: `\\` and `\|` decode; any other backslash stays literal. */
function unescapeCell(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && (value[i + 1] === '|' || value[i + 1] === '\\')) out += value[++i];
    else out += value[i];
  }
  return out;
}

const text = (value: number | null): string => (value === null ? '' : String(value));

/**
 * B12: a read row to the sheet's draft. Only Run and Gym rows are tappable, so any other type prefills as Gym.
 * A cell the summary parser cannot read (or a split that is not a known value) stays empty for the owner to fill.
 */
export function rowToDraft(row: TrainingRow): TrainingDraft {
  const group = row.split.startsWith('Group: ') ? row.split.slice('Group: '.length) : null;
  const split = row.split === 'Bicep' || row.split === 'Tricep' || row.split === 'Legs' || group !== null
    ? (group !== null ? 'Group' : (row.split as 'Bicep' | 'Tricep' | 'Legs'))
    : 'Bicep';
  return {
    type: row.type === 'Run' ? 'Run' : 'Gym',
    when: row.time ? `${row.date}T${row.time}` : '',
    distance: text(numberWithUnit(row.distance, 'km')),
    duration: text(numberWithUnit(row.duration, 'min')),
    weight: text(numberWithUnit(row.weight, 'kg')),
    split,
    className: group === null ? '' : unescapeCell(group),
    note: unescapeCell(row.note),
  };
}
