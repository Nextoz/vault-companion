// The user's action instant as ISO-8601 with the device's local offset (commands.md: occurredAt).

const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0');

/** The calendar date (YYYY-MM-DD) of an instant in an IANA time zone, as the server dates `✅` (A16/A38). */
export function dateIn(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * `offsetMinutes` follows `Date#getTimezoneOffset` (UTC − local, so UTC+2 is -120); injectable for tests.
 */
export function isoWithOffset(date: Date, offsetMinutes = date.getTimezoneOffset()): string {
  const local = new Date(date.getTime() - offsetMinutes * 60_000);
  const east = -offsetMinutes;
  const sign = east >= 0 ? '+' : '-';
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${sign}${pad(east / 60)}:${pad(east % 60)}`
  );
}
