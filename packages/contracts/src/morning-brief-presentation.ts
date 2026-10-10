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
