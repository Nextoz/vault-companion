import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';

export type DisplayState = 'Running' | 'Failed' | 'Degraded' | 'Healthy' | 'Stale' | 'No status yet';
type ScoutEntry = ScoutsResponse['scouts'][number];
const instant = (value: string | null) => value === null ? NaN : Date.parse(value);
export function displayState(status: ScoutStatus | null, now: string | number): DisplayState {
  if (!status) return 'No status yet';
  const time = typeof now === 'number' ? now : Date.parse(now);
  const attempt = instant(status.lastAttemptAt);
  if (status.expectedEveryHours !== null && Number.isFinite(attempt) &&
      time - attempt > (1.25 * status.expectedEveryHours + 1) * 3_600_000) return 'Stale';
  if (status.runStatus === 'failed') return 'Failed';
  if (status.runStatus === 'degraded') return 'Degraded';
  if (status.runStatus === 'running' && Number.isFinite(attempt) &&
      (status.lastSuccessAt === null || attempt > instant(status.lastSuccessAt))) return 'Running';
  if (status.runStatus === 'success' && Number.isFinite(attempt) && Number.isFinite(instant(status.lastSuccessAt))) return 'Healthy';
  return 'No status yet';
}
const localDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen',
  year: 'numeric', month: 'short', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function dateParts(at: number) {
  return Object.fromEntries(localDate.formatToParts(at).map(({ type, value }) => [type, type === 'month' ? value.slice(0, 3) : value]));
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function exactTime(at: string | null): string {
  if (!Number.isFinite(instant(at))) return '—';
  const p = dateParts(instant(at));
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Copenhagen', timeZoneName: 'shortOffset' })
    .formatToParts(instant(at)).find((part) => part.type === 'timeZoneName')?.value;
  return `${p['day']} ${p['month']} ${p['year']} ${p['hour']}:${p['minute']} (${zone}, Europe/Copenhagen)`;
}
export function relativeTime(at: string | null, now: string | number): string {
  const delta = (typeof now === 'number' ? now : Date.parse(now)) - instant(at);
  if (!Number.isFinite(delta)) return '—';
  const minutes = Math.floor(Math.max(0, delta) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const p = dateParts(instant(at));
  const current = dateParts(typeof now === 'number' ? now : Date.parse(now));
  // Calendar dates, not elapsed 24-hour periods: Copenhagen days may be 23 or 25 hours.
  const day = (parts: Record<string, string>) => Date.UTC(Number(parts['year']), MONTHS.indexOf(parts['month']!), Number(parts['day']));
  const days = (day(current) - day(p)) / 86_400_000;
  const label = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${p['weekday']} ${p['day']} ${p['month']}`;
  return `${label} ${p['hour']}:${p['minute']}`;
}
export function lastRun(status: ScoutStatus): string | null {
  return [status.lastAttemptAt, status.lastSuccessAt].filter((at): at is string => at !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
export function attentionCount(response: ScoutsResponse): number {
  return response.scouts.filter((entry) => {
    const state = displayState(entry.state === 'ok' ? entry.status : null, response.now);
    return state === 'Failed' || state === 'Stale';
  }).length;
}

/** UX4: the noun for a count, so "1 scout" never reads "1 scouts". `plural` defaults to the singular plus an "s". */
export function pluralNoun(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** UX4: a counted phrase - "1 scout" / "2 scouts" (see `pluralNoun` for the noun rule). */
export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${pluralNoun(count, singular, plural)}`;
}

/** UX4: the one sentence both the morning line and the Scouts tab show, grammatical at every count. */
export function scoutsNeedAttention(count: number): string {
  return `${pluralise(count, 'scout')} ${count === 1 ? 'needs' : 'need'} attention`;
}

/**
 * UX4: the scouts that belong on "What your scouts found". A Failed or Stale run has no previewable result and is
 * already the health board's attention row, so the Insights cards do not repeat it; unreadable records pass through
 * (Insights ignores them anyway). Pure.
 */
export function previewableScouts(scouts: readonly ScoutEntry[], now: string): ScoutEntry[] {
  return scouts.filter((entry) => {
    if (entry.state !== 'ok') return true;
    const state = displayState(entry.status, now);
    return state !== 'Failed' && state !== 'Stale';
  });
}
