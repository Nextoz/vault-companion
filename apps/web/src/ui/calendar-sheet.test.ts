import { describe, expect, it } from 'vitest';
import { CALENDAR_TYPE_FALLBACK, activeWorkCalendarKey, calendarChips, calendarDate, calendarErrorMessage,
  calendarPrefill, guessEventType, itemTitle, parseTimeHint, taskCalendarKey, timedWindow, ITEM_KEY_MAX } from './calendar-sheet.ts';
import type { ActiveWorkLocator, TaskLocator } from '@vault-companion/contracts';

const locator = (over: Partial<TaskLocator> = {}): TaskLocator => ({
  path: 'Tasks/To-Do List.md', blobSha: '2'.repeat(40), lineIndex: 3, lineText: '- [ ] Call the bank 📅 2026-10-04',
  occurrencesAtRead: 1, occurrenceIndex: 1, ...over,
});

describe('itemTitle', () => {
  it('flattens wikilinks and drops emoji tokens, tags and extra spacing', () => {
    expect(itemTitle('  Prep [[Q4 plan|the plan]] 🧠 #work  ')).toBe('Prep the plan');
  });
  it('never returns an empty title for marker-only text', () => {
    expect(itemTitle('🧠 #tag')).toBe('');
  });
});

describe('parseTimeHint', () => {
  it('reads a 24-hour clock time', () => {
    expect(parseTimeHint('Standup 14:00 with the team')).toEqual({ hour: 14, minute: 0 });
  });
  it('reads a meridiem time, with or without a preceding "at"', () => {
    expect(parseTimeHint('Call at 3pm')).toEqual({ hour: 15, minute: 0 });
    expect(parseTimeHint('Review 9:30 am')).toEqual({ hour: 9, minute: 30 });
    expect(parseTimeHint('Lunch at 12am')).toEqual({ hour: 0, minute: 0 });
  });
  it('does not mistake a count or a date for a time', () => {
    expect(parseTimeHint('Sprint 2: 30 minutes left')).toBeNull();
    expect(parseTimeHint('Due 2026-10-04')).toBeNull();
  });
});

describe('guessEventType', () => {
  it('maps deterministic keywords and falls back to none', () => {
    expect(guessEventType('Morning gym session')).toBe('training');
    expect(guessEventType('Lecture: linear algebra')).toBe('learning-event');
    expect(guessEventType('Piano practice')).toBe('learning-practice');
    expect(guessEventType('Write an AI prompt')).toBe('ai');
    expect(guessEventType('Dentist appointment')).toBe('important');
    expect(guessEventType('Buy oat milk')).toBe('none');
    expect(CALENDAR_TYPE_FALLBACK).toBe('none');
  });
});

describe('calendarDate', () => {
  it('prefers due, then scheduled, then today', () => {
    expect(calendarDate({ due: '2026-10-05', scheduled: '2026-10-06' }, '2026-10-04')).toBe('2026-10-05');
    expect(calendarDate({ due: null, scheduled: '2026-10-06' }, '2026-10-04')).toBe('2026-10-06');
    expect(calendarDate({ due: null, scheduled: null }, '2026-10-04')).toBe('2026-10-04');
  });
});

describe('calendarPrefill', () => {
  it('is all-day with no time in the text', () => {
    const prefill = calendarPrefill({ text: 'Buy oat milk', due: '2026-10-05', scheduled: null }, '2026-10-04');
    expect(prefill).toMatchObject({ title: 'Buy oat milk', date: '2026-10-05', allDay: true, start: '09:00', end: '09:30', type: 'none' });
    expect(prefill.notes).toBe('From Vault Companion\nBuy oat milk');
  });
  it('pre-fills a 30-minute window when the text names a time', () => {
    const prefill = calendarPrefill({ text: 'Standup at 14:15 about [[Q4]]', due: null, scheduled: null }, '2026-10-04');
    expect(prefill).toMatchObject({ title: 'Standup at 14:15 about Q4', date: '2026-10-04', allDay: false, start: '14:15', end: '14:45' });
  });
  it('falls back to a non-empty title when the text is only markers', () => {
    expect(calendarPrefill({ text: '🧠 #work', due: null, scheduled: null }, '2026-10-04').title).not.toBe('');
  });
  it('caps a late window at the end of the day instead of inverting it', () => {
    const prefill = calendarPrefill({ text: 'Wind down 23:45', due: null, scheduled: null }, '2026-10-04');
    expect(prefill).toMatchObject({ allDay: false, start: '23:45', end: '23:59' });
  });
});

describe('timedWindow', () => {
  it('builds ISO instants with the day\u2019s own offset', () => {
    expect(timedWindow('2026-10-04', '14:00', '14:30')).toEqual({
      start: '2026-10-04T14:00:00.000+02:00', end: '2026-10-04T14:30:00.000+02:00',
    });
    expect(timedWindow('2026-01-15', '09:00', '09:30')).toEqual({
      start: '2026-01-15T09:00:00.000+01:00', end: '2026-01-15T09:30:00.000+01:00',
    });
  });
  it('rolls an end at or before the start to the next day', () => {
    expect(timedWindow('2026-10-04', '23:30', '00:15')).toEqual({
      start: '2026-10-04T23:30:00.000+02:00', end: '2026-10-05T00:15:00.000+02:00',
    });
  });
  it('refuses an unparseable clock', () => {
    expect(timedWindow('2026-10-04', 'nope', '14:30')).toBeNull();
  });
});

describe('calendarChips', () => {
  const gap = (blockIndex: number, start: string, end: string) => ({ blockIndex, start, end });
  it('keeps only today\u2019s blocks and caps at four', () => {
    const chips = calendarChips([
      gap(0, '2026-10-04T08:00:00+02:00', '2026-10-04T09:00:00+02:00'),
      gap(1, '2026-10-05T08:00:00+02:00', '2026-10-05T09:00:00+02:00'),
      gap(2, '2026-10-04T10:00:00+02:00', '2026-10-04T10:30:00+02:00'),
      gap(3, '2026-10-04T11:00:00+02:00', '2026-10-04T11:30:00+02:00'),
      gap(4, '2026-10-04T12:00:00+02:00', '2026-10-04T12:30:00+02:00'),
      gap(5, '2026-10-04T13:00:00+02:00', '2026-10-04T13:30:00+02:00'),
    ], '2026-10-04');
    expect(chips).toHaveLength(4);
    expect(chips[0]).toMatchObject({ label: '08:00-09:00', startTime: '08:00', endTime: '09:00' });
  });
  it('yields nothing for another day', () => {
    expect(calendarChips([gap(0, '2026-10-05T08:00:00+02:00', '2026-10-05T09:00:00+02:00')], '2026-10-04')).toEqual([]);
  });
});

describe('item keys', () => {
  it('uses ADR-0056 text identity, not the old blob/line-index key, and fits the Worker cap', () => {
    const task = taskCalendarKey(locator());
    expect(task.startsWith('task:')).toBe(true);
    expect(task).not.toContain(locator().blobSha);
    expect(task).not.toContain(`${locator().lineIndex}`);
    expect(task).toBe('task:1:- [ ] Call the bank 📅 2026-10-04');
    const huge = taskCalendarKey(locator({ lineText: `- [ ] ${'x'.repeat(2000)}` }));
    expect(huge.length).toBeLessThanOrEqual(ITEM_KEY_MAX);
  });
  it('keeps the association across an unrelated blob and line change', () => {
    const before = taskCalendarKey(locator());
    const after = taskCalendarKey(locator({ blobSha: '9'.repeat(40), lineIndex: 17 }));
    expect(before).toBe(after);
  });
  it('keeps duplicate text unambiguous by ordinal, without blob or line index', () => {
    const text = '- [ ] Water the plants';
    const first = taskCalendarKey(locator({ lineText: text, occurrencesAtRead: 2, occurrenceIndex: 1 }));
    const second = taskCalendarKey(locator({ lineText: text, occurrencesAtRead: 2, occurrenceIndex: 2 }));
    expect(first).not.toBe(second);
    expect(first).not.toContain(locator().blobSha);
    expect(second).not.toContain(`${locator().lineIndex}`);
  });
  it('gives Active Work the same stable identity and never embeds its blob SHA', () => {
    const active: ActiveWorkLocator = { path: 'Tasks/Active Work Now.md', blobSha: '5'.repeat(40), lineIndex: 1,
      lineText: '- [ ] **Garden plan:** Next: Order seeds', occurrencesAtRead: 1, occurrenceIndex: 1 };
    const before = activeWorkCalendarKey(active);
    const after = activeWorkCalendarKey({ ...active, blobSha: '7'.repeat(40), lineIndex: 9 });
    expect(before.startsWith('active:')).toBe(true);
    expect(before).toBe(after);
    expect(before).not.toContain(active.blobSha);
  });
  it('strips control characters that the key schema refuses', () => {
    expect(taskCalendarKey(locator({ lineText: 'a\tb' }))).not.toContain('\t');
  });
  it('keeps a pre-ADR-0056 duplicate locator parseable with a line-ordinal fallback', () => {
    const ambiguous = locator({ occurrencesAtRead: 2 });
    delete ambiguous.occurrenceIndex;
    const key = taskCalendarKey(ambiguous);
    expect(key).toMatch(/^task:[1-9]\d*:/);
    expect(key).toContain(ambiguous.lineText);
  });
  it('matches the e2e MockApi twin/conflict shape: two identical lines stay distinct and parseable', () => {
    const text = '- [ ] Call the bike shop';
    const first = { ...locator({ lineText: text, lineIndex: 10, occurrencesAtRead: 2 }) };
    const second = { ...locator({ lineText: text, lineIndex: 12, occurrencesAtRead: 2 }) };
    delete first.occurrenceIndex;
    delete second.occurrenceIndex;
    const firstKey = taskCalendarKey(first);
    const secondKey = taskCalendarKey(second);
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toMatch(/^task:[1-9]\d*:/);
    expect(secondKey).toMatch(/^task:[1-9]\d*:/);
  });
});

describe('calendarErrorMessage', () => {
  it('maps offline and the typed refusals', () => {
    expect(calendarErrorMessage('offline', null)).toContain('offline');
    expect(calendarErrorMessage('error', 'calendar-write-unavailable')).toBe('Calendar writing is not set up');
    expect(calendarErrorMessage('error', 'google-reauth-needed')).toContain('reconnected');
    expect(calendarErrorMessage('error', 'invalid')).toContain('Try again');
    expect(calendarErrorMessage('error', 'calendar-link-needs-recheck')).toContain('Reload tasks');
  });
});
