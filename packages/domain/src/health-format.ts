/** Calendar date of the Copenhagen wall-clock time shifted by `shiftHours` (not absolute time). */
export function wallClockDate(ms: number, timeZone: string, shiftHours: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const shifted = new Date(
    Date.UTC(value('year'), value('month') - 1, value('day'), value('hour') + shiftHours, value('minute'), value('second'), value('fractionalSecond')),
  );
  return shifted.toISOString().slice(0, 10);
}

export function weekday(date: string): string {
  const instant = new Date(`${date}T00:00:00Z`);
  // The date string is a calendar date, so its weekday is timezone-independent; format the UTC-midnight
  // instant as UTC, never in the user zone (behind-UTC zones would otherwise get the previous day).
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(instant);
}

/** Python-style banker's rounding, then formatting with no trailing zeros. */
export function roundHalfEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floored = Math.floor(scaled);
  const fraction = scaled - floored;
  let rounded: number;
  if (fraction < 0.5) rounded = floored;
  else if (fraction > 0.5) rounded = floored + 1;
  else rounded = floored % 2 === 0 ? floored : floored + 1;
  return rounded / factor;
}

export function formatNumber(value: number, decimals: number): string {
  const rounded = roundHalfEven(value, decimals);
  if (decimals === 0) return String(rounded);
  let out = rounded.toFixed(decimals);
  out = out.replace(/0+$/, '').replace(/\.$/, '');
  return out;
}

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
