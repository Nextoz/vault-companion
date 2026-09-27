import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';

export type DisplayState = 'Running' | 'Failed' | 'Degraded' | 'Healthy' | 'Stale' | 'No status yet';
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
  const day = (parts: Record<string, string>) => Date.parse(`${parts['day']} ${parts['month']} ${parts['year']} 00:00:00 GMT`);
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
