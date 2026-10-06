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
  return file.unavailable.map((name) => {
    const code = file.unavailableReasons?.[name];
    const reason = code === 'google-reauth-needed' ? 'Google sign-in needs renewing'
      : code === 'threw' ? 'it failed unexpectedly' : code ?? 'reason not provided';
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} unavailable: ${reason}`;
  });
}

export function briefTodoAge(todo: { overdueDays?: number | undefined }): string {
  return todo.overdueDays === undefined ? '' : ` (${todo.overdueDays} ${todo.overdueDays === 1 ? 'day' : 'days'} overdue)`;
}
