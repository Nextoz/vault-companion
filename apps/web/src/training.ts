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
  /** `YYYY-MM-DDTHH:MM` for the datetime-local input; empty when the read had no time. */
  when: string;
  distance: string;
  /** The original cell when it is non-empty but does not parse; null otherwise. */
  distanceWas: string | null;
  duration: string;
  durationWas: string | null;
  weight: string;
  weightWas: string | null;
  /** Empty when the read's split is not a known workout; the sheet then requires a choice before saving. */
  split: '' | 'Bicep' | 'Tricep' | 'Legs' | 'Group';
  className: string;
  note: string;
}

const text = (value: number | null): string => (value === null ? '' : String(value));

/**
 * B12: a read row to the sheet's draft. Only Run and Gym rows are tappable, so any other type prefills as Gym.
 * The read already decodes cell escapes, so note and class travel verbatim. A cell that does not parse stays
 * empty, and its raw non-empty value is kept in `…Was` so the sheet can show what it could not read.
 */
export function rowToDraft(row: TrainingRow): TrainingDraft {
  const distance = numberWithUnit(row.distance, 'km');
  const duration = numberWithUnit(row.duration, 'min');
  const weight = numberWithUnit(row.weight, 'kg');
  const group = row.split.startsWith('Group: ') ? row.split.slice('Group: '.length) : null;
  const split = row.split === 'Bicep' || row.split === 'Tricep' || row.split === 'Legs' || group !== null
    ? (group !== null ? 'Group' : (row.split as 'Bicep' | 'Tricep' | 'Legs'))
    : '';
  return {
    type: row.type === 'Run' ? 'Run' : 'Gym',
    when: row.time ? `${row.date}T${row.time}` : '',
    distance: text(distance),
    distanceWas: distance === null && row.distance !== '' ? row.distance : null,
    duration: text(duration),
    durationWas: duration === null && row.duration !== '' ? row.duration : null,
    weight: text(weight),
    weightWas: weight === null && row.weight !== '' ? row.weight : null,
    split,
    className: group ?? '',
    note: row.note,
  };
}
