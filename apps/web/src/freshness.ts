import type { TasksResponse } from '@vault-companion/contracts';

export const FRESH_FOR_MS = 10 * 60 * 1000;
const time = (at: number, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
const day = (at: number, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export function displayTime(at: number, now: number, timeZone: string): string {
  if (day(at, timeZone) === day(now, timeZone)) return time(at, timeZone);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part('weekday')} ${part('day')} ${part('month')} ${time(at, timeZone)}`;
}

export function vaultFreshness(read: Pick<TasksResponse, 'revision' | 'vault' | 'timeZone'>, checkedAt: number | null, failed: boolean, now: number) {
  const warning = failed || checkedAt === null || now - checkedAt > FRESH_FOR_MS;
  return {
    updated: read.vault
      ? `Vault updated ${displayTime(Date.parse(read.vault.committedAt), now, read.timeZone)} · from ${read.vault.fromApp ? 'this app' : 'desktop'}`
      : `Vault revision ${read.revision.slice(0, 7)}`,
    checked: checkedAt === null ? 'Not refreshed yet' : `${warning ? 'Not refreshed since' : 'Checked'} ${displayTime(checkedAt, now, read.timeZone)}`,
    warning,
  };
}
