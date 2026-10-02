// Small bar charts for iPhone-mode screens (UI refresh slice 4): counts of dated items, calendar arithmetic only.

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface Bar {
  label: string;
  value: number;
  current: boolean;
}

/** A Markdown date plus n days, as a Markdown date; never the device time zone. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the ISO week holding the date. */
export function mondayOf(date: string): string {
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

function countBetween(dates: readonly string[], from: string, to: string): number {
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= from && d <= to).length;
}

/** One bar per weekday of today's week, Monday first; today is the current bar. */
export function weekdayBars(dates: readonly string[], today: string): Bar[] {
  const monday = mondayOf(today);
  return WEEKDAYS.map((label, i) => {
    const day = addDays(monday, i);
    return { label, value: countBetween(dates, day, day), current: day === today };
  });
}

/** One bar per week for the last `weeks` weeks, oldest first, labelled "28 Sep" by its Monday. */
export function weekBars(dates: readonly string[], today: string, weeks = 8): Bar[] {
  const thisMonday = mondayOf(today);
  return Array.from({ length: weeks }, (_, i) => {
    const monday = addDays(thisMonday, (i - weeks + 1) * 7);
    const d = new Date(`${monday}T00:00:00Z`);
    return {
      label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      value: countBetween(dates, monday, addDays(monday, 6)),
      current: monday === thisMonday,
    };
  });
}
