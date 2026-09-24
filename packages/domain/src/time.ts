// Time policy: docs/vault-contract.md §6.

export const DEFAULT_USER_TIME_ZONE = 'Europe/Copenhagen';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const BACKDATED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of `instant` in the user's IANA zone. The device offset is irrelevant. */
export function userDate(instant: string | Date, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError('invalid instant');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function checkOccurredAt(
  occurredAt: string,
  now: Date,
): { ok: false } | { ok: true; backdated: boolean } {
  const delta = new Date(occurredAt).getTime() - now.getTime();
  if (Number.isNaN(delta) || delta > MAX_FUTURE_SKEW_MS) return { ok: false };
  return { ok: true, backdated: -delta > BACKDATED_AFTER_MS };
}
