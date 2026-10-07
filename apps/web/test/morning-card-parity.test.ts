import { describe, expect, it } from 'vitest';
import { MorningBriefResponse } from '@vault-companion/contracts';
import { briefLines } from '../src/ui/morning-card.ts';
import { BriefFile } from '../../../packages/domain/src/morning-brief-file.ts';
import { escapeHtml, renderBriefEmail } from '../../worker/src/morning-brief-email.ts';

describe('v2 brief sheet and email parity', () => {
  const date = '2026-10-02';
  const meeting = (title: string, extra = {}) => ({ title, start: `${date}T09:00:00+02:00`, end: `${date}T10:00:00+02:00`, allDay: false, clash: false, ...extra });
  const synthetic = () => BriefFile.parse({
    schemaVersion: 2, date, generatedAt: `${date}T06:31:00+02:00`, source: 'model',
    unavailable: ['mail'], unavailableReasons: { mail: 'google-reauth-needed' },
    brief: { source: 'model', dayLine: 'Synthetic Friday', gaps: [],
      meetings: [
        meeting('Design & review', { clash: true, clashWith: 'Team <sync>', link: 'https://calendar.google.com/calendar/event?eid=synthetic&mode=day' }),
        meeting('Team <sync>', { clash: true, clashWith: 'Design & review' }),
        meeting('Planning day', { allDay: true }),
        ...Array.from({ length: 3 }, (_, i) => meeting(`Session ${i}`)),
      ],
      todos: Array.from({ length: 6 }, (_, id) => ({ id, text: `Task ${id}`, due: id === 0 ? '2026-09-29' : date, bill: false, ...(id === 0 ? { overdueDays: 3 } : {}) })),
    },
  });
  const response = (file: ReturnType<typeof synthetic>) => MorningBriefResponse.parse({
    revision: 'a'.repeat(40), date: file.date, generatedAt: file.generatedAt, source: file.source,
    unavailable: file.unavailable, unavailableReasons: file.unavailableReasons, brief: file.brief,
  });

  it('shares six meeting rows, local times, clashes, HTTPS links, reasons and capped overdue todos', () => {
    const file = synthetic();
    const lines = briefLines(response(file), date)!;
    const email = renderBriefEmail(file);
    const meetings = lines.filter((row) => row.id.startsWith('meeting-'));
    expect(meetings).toHaveLength(6);
    expect(meetings[0]?.text).toBe('All day  Planning day');
    expect(meetings[1]?.text).toBe('09:00-10:00  Design & review');
    expect(meetings[1]?.clash).toBe('Clash with Team <sync>');
    expect(meetings[1]?.link).toBe(file.brief.meetings[0]?.link);
    expect(meetings[2]?.link).toBeUndefined();
    expect(lines.find((row) => row.id === 'today')?.heading).toBe(true);
    expect(lines.filter((row) => row.todo)).toHaveLength(5);
    expect(lines.find((row) => row.id === 'todo-0')?.text).toBe('Task 0 (3 days overdue)');
    expect(lines.find((row) => row.id === 'todo-1')?.text).toBe('Task 1');
    expect(lines.some((row) => row.text === 'Mail unavailable: Google sign-in needs renewing')).toBe(true);
    for (const row of lines) {
      for (const value of [row.text, row.clash, row.link].filter((value): value is string => value !== undefined)) {
        expect(email.text).toContain(value);
        expect(email.html).toContain(escapeHtml(value));
      }
    }
    expect(email.text).not.toContain('Task 5');
    expect(email.html).not.toContain('Task 5');
    expect(email.html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(email.html).not.toContain('<sync>');
  });

  it('shows empty days, but never suggests free time or no meetings when Calendar failed', () => {
    const file = synthetic();
    file.brief.meetings = [];
    expect(briefLines(response(file), date)?.some((row) => row.text === 'No meetings today')).toBe(true);
    expect(renderBriefEmail(file).text).toContain('No meetings today');
    file.unavailable = ['calendar', 'mail', 'weather'];
    file.unavailableReasons = { calendar: 'google-reauth-needed', mail: 'threw', weather: 'unauthorized' };
    file.brief.gaps = [{ blockIndex: 0, start: `${date}T10:00:00+02:00`, end: `${date}T11:00:00+02:00`, suggestion: 'Free time suggestion' }];
    const lines = briefLines(response(file), date)!;
    const email = renderBriefEmail(file);
    for (const text of ['Calendar unavailable: Google sign-in needs renewing', 'Mail unavailable: it failed unexpectedly', 'Weather unavailable: unauthorized']) {
      expect(lines.some((row) => row.text === text)).toBe(true);
      expect(email.text).toContain(text);
      expect(email.html).toContain(text);
    }
    for (const output of [JSON.stringify(lines), email.text, email.html]) {
      expect(output).not.toContain('Free time suggestion');
      expect(output).not.toContain('No meetings today');
    }
  });

  it.each(['javascript:alert(1)', 'http://calendar.google.com/event', 'invalid'])('omits unsafe links at rendering time: %s', (link) => {
    const file = synthetic();
    file.brief.meetings = [meeting('Unsafe link', { link })];
    expect(briefLines(response(file), date)?.find((row) => row.id === 'meeting-0')?.link).toBeUndefined();
    const email = renderBriefEmail(file);
    expect(email.text).not.toContain('Open in Calendar');
    expect(email.html).not.toContain('<a ');
  });
});

