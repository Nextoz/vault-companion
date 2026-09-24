// The user's action instant as ISO-8601 with the device's local offset (commands.md: occurredAt).

const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0');

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
