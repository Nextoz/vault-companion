// Progress Wall (ADR-0027): what happened per Copenhagen week, derived read-only from reads the app already makes.
// Counts are evidence, never scores: no streaks, targets or comparisons between weeks.
import type { HistoryItem, NotesResponse, TrainingRow, TriageResponse } from '@vault-companion/contracts';
import { numberWithUnit } from './training.ts';
import { copenhagenDay, effectiveDecisions } from './triage.ts';

type Decision = TriageResponse['decisions'][number];
type Note = NotesResponse['notes'][number];

/** Each source loads independently; `null` means that read failed and the source is shown as unavailable. */
export interface ProgressInputs {
  history: readonly HistoryItem[] | null;
  training: readonly TrainingRow[] | null;
  decisions: readonly Decision[] | null;
  notes: readonly Note[] | null;
}

export interface ProgressWeek {
  /** Monday and Sunday of the week, YYYY-MM-DD (Europe/Copenhagen calendar dates). */
  monday: string;
  sunday: string;
  tasks: HistoryItem[] | null;
  activeWork: HistoryItem[] | null;
  runs: { count: number; km: number; items: TrainingRow[] } | null;
  gym: { count: number; splits: string[]; items: TrainingRow[] } | null;
  events: { go: Decision[]; attended: Decision[] } | null;
  notes: Note[] | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Monday of the week containing a date. A calendar date (as written in Markdown) is taken as is; an instant is first
 * turned into its Copenhagen calendar date. Calendar arithmetic only, so DST weeks are never 7 × 24 h.
 */
export function weekOf(dateOrInstant: string): string {
  const date = DATE.test(dateOrInstant) ? dateOrInstant : copenhagenDay(dateOrInstant);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

/** Newest week first: this week, then the `weeks - 1` before it. Future-dated entries fall outside every week. */
export function progressWeeks(inputs: ProgressInputs, today: string, weeks = 8): ProgressWeek[] {
  const current = weekOf(today);
  const mondays = Array.from({ length: weeks }, (_, n) => addDays(current, -7 * n));
  const byWeek = <T>(items: readonly T[] | null, dateOf: (item: T) => string | null) => {
    const out = new Map<string, T[]>(mondays.map((m) => [m, []]));
    for (const item of items ?? []) {
      const date = dateOf(item);
      if (date !== null && date <= addDays(current, 6)) out.get(weekOf(date))?.push(item);
    }
    return (monday: string) => (items === null ? null : out.get(monday)!);
  };
  const tasks = byWeek(inputs.history?.filter((i) => i.source === 'todo') ?? null, (i) => i.doneDate);
  const activeWork = byWeek(inputs.history?.filter((i) => i.source === 'active-work') ?? null, (i) => i.doneDate);
  const runs = byWeek(inputs.training?.filter((r) => r.type === 'Run') ?? null, (r) => r.date);
  const gym = byWeek(inputs.training?.filter((r) => r.type === 'Gym') ?? null, (r) => r.date);
  const notes = byWeek(inputs.notes, (n) => n.date);
  // Latest non-undone decision per event (ADR-0024); an event counts in the week it takes place.
  const latest = inputs.decisions === null ? null
    : [...new Map(effectiveDecisions(inputs.decisions).map((d) => [d.eventId, d])).values()];
  const events = byWeek(latest?.filter((d) => d.decision === 'go' || (d.decision === 'attended' && d.outcome !== 'missed')) ?? null,
    (d) => d.start ?? d.at);
  return mondays.map((monday) => {
    const run = runs(monday);
    const lift = gym(monday);
    const event = events(monday);
    return {
      monday, sunday: addDays(monday, 6),
      tasks: tasks(monday), activeWork: activeWork(monday),
      runs: run && { count: run.length, km: Math.round(run.reduce((sum, r) => sum + (numberWithUnit(r.distance, 'km') ?? 0), 0) * 10) / 10, items: run },
      gym: lift && { count: lift.length, splits: lift.map((r) => r.split).filter(Boolean), items: lift },
      events: event && { go: event.filter((d) => d.decision === 'go'), attended: event.filter((d) => d.decision === 'attended') },
      notes: notes(monday),
    };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "6 tasks · 2 Active Work · 3 runs (14.6 km) · 1 gym · 2 events (1 attended) · 2 notes"; zero sources are omitted. */
export function weekSummary(week: ProgressWeek, current: boolean, missing: readonly string[] = []): string {
  const events = week.events ? week.events.go.length + week.events.attended.length : 0;
  const parts = [
    week.tasks?.length ? plural(week.tasks.length, 'task') : '',
    week.activeWork?.length ? `${week.activeWork.length} Active Work` : '',
    week.runs?.count ? `${plural(week.runs.count, 'run')}${week.runs.km ? ` (${week.runs.km} km)` : ''}` : '',
    week.gym?.count ? `${week.gym.count} gym` : '',
    events ? `${plural(events, 'event')}${week.events!.attended.length ? ` (${week.events!.attended.length} attended)` : ''}` : '',
    week.notes?.length ? plural(week.notes.length, 'note') : '',
  ].filter(Boolean);
  // A week is only "Nothing recorded" when every source answered; otherwise say which ones are missing.
  if (missing.length) return [...parts, ...missing].join(' · ');
  return parts.length ? parts.join(' · ') : current ? 'Nothing recorded this week' : 'Nothing recorded';
}

/** Sources that could not be read, as shown in the card ("Training unavailable"). */
export function unavailable(inputs: ProgressInputs): string[] {
  return [inputs.history === null && 'Tasks', inputs.training === null && 'Training', inputs.decisions === null && 'Events',
    inputs.notes === null && 'Notes'].filter((s): s is string => !!s).map((s) => `${s} unavailable`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21–27 Sep", or "28 Sep – 4 Oct" across a month end. */
export function weekRange(week: Pick<ProgressWeek, 'monday' | 'sunday'>): string {
  const [, m1, d1] = week.monday.split('-').map(Number) as [number, number, number];
  const [, m2, d2] = week.sunday.split('-').map(Number) as [number, number, number];
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m2 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`;
}
