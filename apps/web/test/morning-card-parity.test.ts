import { describe, expect, it } from 'vitest';
import { briefCopenhagen, briefNeedsYou, briefTimeline, MorningBriefResponse } from '@vault-companion/contracts';
import { BriefFile } from '../../../packages/domain/src/morning-brief-file.ts';
import { escapeHtml, renderBriefEmail } from '../../worker/src/morning-brief-email.ts';
import { morningBriefSheet } from '../src/ui/morning-card.ts';

describe('v2 brief sheet and email parity (MB4)', () => {
  const date = '2026-10-02';
  const meeting = (title: string, start: string, end: string, extra = {}) =>
    ({ title, start: `${date}T${start}:00+02:00`, end: `${date}T${end}:00+02:00`, allDay: false, clash: false, ...extra });
  const synthetic = () => BriefFile.parse({
    schemaVersion: 2, date, generatedAt: `${date}T06:31:00+02:00`, source: 'model',
    unavailable: ['mail'], unavailableReasons: { mail: 'google-reauth-needed' },
    brief: { source: 'model', dayLine: 'Synthetic Friday', gaps: [
      { blockIndex: 0, start: `${date}T07:00:00+02:00`, end: `${date}T08:00:00+02:00`, suggestion: 'Take a walk' },
      { blockIndex: 1, start: `${date}T12:00:00+02:00`, end: `${date}T12:45:00+02:00` },
    ],
      meetings: [
        meeting('Design review', '09:00', '10:00', { clash: true, clashWith: 'Team sync', link: 'https://calendar.google.com/calendar/event?eid=synthetic&mode=day' }),
        meeting('Team sync', '09:30', '10:30', { clash: true, clashWith: 'Design review' }),
        meeting('Planning day', '00:00', '00:00', { allDay: true }),
        meeting('Lunch', '11:00', '12:00'),
      ],
      todos: Array.from({ length: 6 }, (_, id) => ({ id, text: `Task ${id}`, due: id === 0 ? '2026-09-29' : date, bill: false, ...(id === 0 ? { overdueDays: 3 } : {}) })),
    },
  });
  const response = (file: ReturnType<typeof synthetic>) => MorningBriefResponse.parse({
    revision: 'a'.repeat(40), date: file.date, generatedAt: file.generatedAt, source: file.source,
    unavailable: file.unavailable, unavailableReasons: file.unavailableReasons, brief: file.brief,
  });
  const now = new Date(`${date}T12:30:00+02:00`);

  it('renders the same timeline rows, local times, clashes, links and capped todos from the shared helper', () => {
    const file = synthetic();
    const timeline = briefTimeline(file, now);
    const sheet = morningBriefSheet(response(file), date, now);
    const email = renderBriefEmail(file, now);
    expect(timeline.rows.map((row) => `${row.time}  ${row.label}`)).toEqual([
      '07:00-08:00  Free 1 h · Take a walk',
      '09:00-10:00  Design review',
      '09:30-10:30  Team sync',
      '11:00-12:00  Lunch',
      '12:00-12:45  Free 45 min',
    ]);
    expect(timeline.allDay).toEqual(['Planning day']);
    // The sheet state and the email both carry exactly these rows - the parity the brief asks for.
    expect(sheet.timeline).toEqual(timeline);
    for (const row of timeline.rows) {
      const line = `${row.time}  ${row.label}`;
      expect(email.text).toContain(line);
      expect(email.html).toContain(escapeHtml(row.time));
      expect(email.html).toContain(escapeHtml(row.label));
      if (row.overlap !== null) { expect(email.text).toContain(row.overlap); expect(email.html).toContain(escapeHtml(row.overlap)); }
      if (row.link !== null) expect(email.html).toContain(`href="${escapeHtml(row.link)}"`);
    }
    expect(sheet.head.map((lineItem) => lineItem.text)).toContain('All day: Planning day');
    expect(email.text).toContain('All day: Planning day');
    expect(sheet.todos.map((todo) => todo.text)[0]).toBe('Task 0 (3 days overdue)');
    expect(email.text).toContain('Task 0 (3 days overdue)');
    expect(email.text).not.toContain('Task 5');
    expect(email.html).not.toContain('Task 5');
    expect(email.html).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('shows empty days, but never suggests free time or no meetings when Calendar failed', () => {
    const file = synthetic();
    file.brief.meetings = [];
    expect(briefTimeline(file, now).rows.map((row) => row.kind)).toEqual(['gap', 'gap']);
    expect(renderBriefEmail(file, now).text).toContain('No meetings today');
    file.unavailable = ['calendar', 'mail', 'weather'];
    file.unavailableReasons = { calendar: 'google-reauth-needed', mail: 'threw', weather: 'unauthorized' };
    const failed = briefTimeline(file, now);
    const email = renderBriefEmail(file, now);
    expect(failed).toEqual({ allDay: [], rows: [], calendarFailed: true });
    for (const text of ['Calendar unavailable: Google sign-in needs renewing', 'Mail unavailable: it failed unexpectedly', 'Weather unavailable: unauthorized']) {
      expect(morningBriefSheet(response(file), date, now).head.map((lineItem) => lineItem.text)).toContain(text);
      expect(email.text).toContain(text);
      expect(email.html).toContain(escapeHtml(text));
    }
    for (const output of [JSON.stringify(failed), email.text, email.html]) {
      expect(output).not.toContain('Take a walk');
      expect(output).not.toContain('No meetings today');
    }
  });

  it('renders the same Needs-you and Copenhagen-today rows in the sheet and the email', () => {
    const file = synthetic();
    file.brief.needsYou = [{ title: 'Synthetic Mail', line: 'A synthetic message.', url: 'https://mail.google.com/mail/u/0/#inbox/synthetic' }];
    file.brief.copenhagen = [{ title: '17:00 Synthetic Event', line: 'A synthetic plan.', url: 'https://www.google.com/calendar/event?eid=synthetic' }];
    const email = renderBriefEmail(file, now);
    const responseFile = response(file);
    for (const [heading, items] of [['Needs you', briefNeedsYou(responseFile)], ['Copenhagen today', briefCopenhagen(responseFile)]] as const) {
      expect(items.length).toBeGreaterThan(0);
      expect(email.text).toContain(heading);
      expect(email.html).toContain(heading);
      for (const item of items) {
        expect(email.text).toContain(`${item.title} - ${item.line}`);
        expect(email.html).toContain(escapeHtml(`${item.title} - ${item.line}`));
        expect(email.html).toContain(`href="${escapeHtml(item.url)}"`);
      }
    }
  });

  it.each(['javascript:alert(1)', 'http://calendar.google.com/event', 'invalid'])('omits unsafe links at rendering time: %s', (link) => {
    const file = synthetic();
    file.brief.meetings = [meeting('Unsafe link', '09:00', '10:00', { link })];
    expect(briefTimeline(file, now).rows[0]!.link).toBeNull();
    const email = renderBriefEmail(file, now);
    expect(email.text).not.toContain('Open in Calendar');
    expect(email.html).not.toContain('<a ');
  });
});
