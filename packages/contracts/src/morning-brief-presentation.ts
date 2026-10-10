import type { MorningBriefResponse } from './index.ts';

/** Shared file-only presentation for the phone and email. Times retain the file's local offset. */
export function briefMeetingRows(file: Pick<MorningBriefResponse, 'brief' | 'unavailable'>): { text: string; clash?: string | undefined; link?: string | undefined }[] {
  if (file.brief.meetings === undefined) return [];
  const meetings = [...file.brief.meetings].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  if (meetings.length === 0) return file.unavailable.includes('calendar') ? [] : [{ text: 'No meetings today' }];
  return meetings.map((meeting) => {
    let link: string | undefined;
    try { if (meeting.link && new URL(meeting.link).protocol === 'https:') link = meeting.link; } catch { /* Omit unsafe links. */ }
    return {
      text: `${meeting.allDay ? 'All day' : `${meeting.start.slice(11, 16)}-${meeting.end.slice(11, 16)}`}  ${meeting.title}`,
      clash: meeting.clash ? (meeting.clashWith ? `Clash with ${meeting.clashWith}` : 'Clash') : undefined,
      link,
    };
  });
}

export function briefUnavailableLines(file: Pick<MorningBriefResponse, 'unavailable' | 'unavailableReasons'>): string[] {
  // The digest reader is rendered per section (News / AI and research) rather than as one reader line.
  return file.unavailable.filter((name) => name !== DIGEST_READER).map((name) => {
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} unavailable: ${reasonText(file.unavailableReasons?.[name])}`;
  });
}

/** The gatherer name whose failure the News and AI-and-research sections report. */
export const DIGEST_READER = 'digest';

function reasonText(code: string | undefined): string {
  return code === 'google-reauth-needed' ? 'Google sign-in needs renewing'
    : code === 'not-found' ? 'the note was not found'
    : code === 'invalid' ? 'the note could not be read'
    : code === 'threw' ? 'it failed unexpectedly' : code ?? 'reason not provided';
}

/** One tracked-digest bullet. `url` is https-only; unsafe entries are dropped from the projection. */
export interface BriefDigestItem {
  readonly title: string;
  readonly line: string;
  readonly url: string;
}

/** The digest's closing thought, replacing the generic closing line when present. */
export interface BriefOneThing {
  readonly text: string;
  readonly quote?: string | undefined;
}

function httpsItems(items: readonly { title: string; line: string; url: string }[] | undefined): BriefDigestItem[] {
  return (items ?? []).filter((item) => /^https:\/\//.test(item.url)).map((item) => ({ title: item.title, line: item.line, url: item.url }));
}

/** The News bullets, in note order ([] when the file predates the digest fields). */
export function briefNews(file: Pick<MorningBriefResponse, 'brief'>): BriefDigestItem[] {
  return httpsItems(file.brief.news);
}

/** The Needs-you bullets, in note order ([] when the file predates the digest fields). */
export function briefNeedsYou(file: Pick<MorningBriefResponse, 'brief'>): BriefDigestItem[] {
  return httpsItems(file.brief.needsYou);
}

/** The Copenhagen-today bullets, in note order ([] when the file predates the digest fields). */
export function briefCopenhagen(file: Pick<MorningBriefResponse, 'brief'>): BriefDigestItem[] {
  return httpsItems(file.brief.copenhagen);
}

/** The AI-and-research bullets, in note order ([] when the file predates the digest fields). */
export function briefResearch(file: Pick<MorningBriefResponse, 'brief'>): BriefDigestItem[] {
  return httpsItems(file.brief.research);
}

/** The One-thing closing block, or null when the digest carried none (the generic closing line then applies). */
export function briefOneThing(file: Pick<MorningBriefResponse, 'brief'>): BriefOneThing | null {
  const oneThing = file.brief.oneThing;
  if (!oneThing) return null;
  return { text: oneThing.text, ...(oneThing.quote !== undefined ? { quote: oneThing.quote } : {}) };
}

/** The plain reason when the digest note could not be read; null when it was (or the file predates it). */
export function briefDigestUnavailable(file: Pick<MorningBriefResponse, 'unavailable' | 'unavailableReasons'>): string | null {
  return file.unavailable.includes(DIGEST_READER) ? reasonText(file.unavailableReasons?.[DIGEST_READER]) : null;
}

export function briefTodoAge(todo: { overdueDays?: number | undefined }): string {
  return todo.overdueDays === undefined ? '' : ` (${todo.overdueDays} ${todo.overdueDays === 1 ? 'day' : 'days'} overdue)`;
}

/** One timeline row: a timed meeting or a free gap. `time` slices the file's own offset, never the device's zone. */
export interface BriefTimelineRow {
  readonly kind: 'meeting' | 'gap';
  readonly start: string;
  readonly end: string;
  /** "09:00-10:00" rendered in the file's local offset (the existing slicing approach). */
  readonly time: string;
  /** Meeting title, or the gap line "Free 1 h 30 min · <suggestion>" / "Free 45 min". */
  readonly label: string;
  /** Gap duration text ("3 h", "45 min", "1 h 30 min"); null for a meeting. */
  readonly duration: string | null;
  /** True when the row's end instant is before the sheet's `now`. */
  readonly ended: boolean;
  /** "Clash" on a clashing meeting; null otherwise. */
  readonly clashBadge: string | null;
  /** "Overlaps 30 min with X" on a clashing meeting; null otherwise. */
  readonly overlap: string | null;
  /** The overlap length in whole minutes; null when the meeting does not clash (or no partner overlaps). */
  readonly overlapMinutes: number | null;
  /** https-only calendar link for a meeting; null otherwise. */
  readonly link: string | null;
}

/** The day in time order (MB4): the same rows feed the phone sheet and the email, so both render identically. */
export interface BriefTimeline {
  readonly allDay: readonly string[];
  readonly rows: readonly BriefTimelineRow[];
  readonly calendarFailed: boolean;
}

const timelineWallClock = (instant: string): string => instant.slice(11, 16);

/** "3 h", "45 min", "1 h 30 min" - plain-language duration for a gap and for an overlap. Tolerant of bad instants. */
export function briefDurationText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  const mins = whole % 60;
  if (hours === 0) return `${mins} min`;
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`;
}

function httpsOnly(link: string | undefined): string | null {
  if (!link) return null;
  try { return new URL(link).protocol === 'https:' ? link : null; } catch { return null; }
}

/** Milliseconds of overlap between two intervals; 0 when they do not overlap (or an instant is unparseable). */
function overlapMs(a: { start: string; end: string }, b: { start: string; end: string }): number {
  const start = Math.max(Date.parse(a.start), Date.parse(b.start));
  const end = Math.min(Date.parse(a.end), Date.parse(b.end));
  return end > start ? end - start : 0;
}

/**
 * MB4: the whole day in time order. One row per timed meeting or free gap (sorted by start), all-day meeting titles
 * on their own line, and every clashing meeting tagged with its partner and overlap length. Calendar failure yields
 * no rows and no gap suggestions (the caller shows the amber reason line instead). Shared by web and email.
 */
export function briefTimeline(file: Pick<MorningBriefResponse, 'brief' | 'unavailable'>, now: Date): BriefTimeline {
  if (file.unavailable.includes('calendar')) return { allDay: [], rows: [], calendarFailed: true };
  const meetings = [...(file.brief.meetings ?? [])].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));
  const allDay = meetings.filter((meeting) => meeting.allDay).map((meeting) => meeting.title);
  const timed = meetings.filter((meeting) => !meeting.allDay);
  const rows: BriefTimelineRow[] = [];
  for (const meeting of timed) {
    const partner = meeting.clash
      ? timed.filter((other) => other !== meeting)
          .map((other) => ({ other, ms: overlapMs(meeting, other) }))
          .filter((candidate) => candidate.ms > 0)
          .sort((a, b) => b.ms - a.ms)[0]
      : undefined;
    const overlapMinutes = partner === undefined ? null : Math.round(partner.ms / 60_000);
    const partnerName = meeting.clashWith ?? partner?.other.title;
    rows.push({
      kind: 'meeting', start: meeting.start, end: meeting.end,
      time: `${timelineWallClock(meeting.start)}-${timelineWallClock(meeting.end)}`,
      label: meeting.title, duration: null,
      ended: Date.parse(meeting.end) < now.getTime(),
      clashBadge: meeting.clash ? 'Clash' : null,
      overlap: overlapMinutes === null ? null : `Overlaps ${briefDurationText(overlapMinutes)} with ${partnerName ?? 'another meeting'}`,
      overlapMinutes,
      link: httpsOnly(meeting.link),
    });
  }
  for (const gap of file.brief.gaps) {
    const duration = briefDurationText((Date.parse(gap.end) - Date.parse(gap.start)) / 60_000);
    rows.push({
      kind: 'gap', start: gap.start, end: gap.end,
      time: `${timelineWallClock(gap.start)}-${timelineWallClock(gap.end)}`,
      label: `Free${duration === '' ? '' : ` ${duration}`}${gap.suggestion === undefined ? '' : ` · ${gap.suggestion}`}`,
      duration: duration === '' ? null : duration,
      ended: Date.parse(gap.end) < now.getTime(),
      clashBadge: null, overlap: null, overlapMinutes: null, link: null,
    });
  }
  rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end) || (a.kind === 'meeting' ? 0 : 1) - (b.kind === 'meeting' ? 0 : 1));
  return { allDay, rows, calendarFailed: false };
}
