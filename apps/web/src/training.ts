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
