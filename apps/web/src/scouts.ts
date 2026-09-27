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
export function relativeTime(at: string | null, now: string | number): string {
  const delta = (typeof now === 'number' ? now : Date.parse(now)) - instant(at);
  if (!Number.isFinite(delta)) return '—';
  const minutes = Math.floor(Math.max(0, delta) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
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
