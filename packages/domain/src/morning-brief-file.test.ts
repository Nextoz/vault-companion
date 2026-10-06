import { describe, expect, it } from 'vitest';
import { parseBriefFile, serializeBriefFile, type BriefFile } from './morning-brief-file.ts';

const file = (over: Record<string, unknown> = {}): BriefFile => ({
  schemaVersion: 2,
  date: '2026-06-15',
  generatedAt: '2026-06-15T04:30:05.000Z',
  source: 'fallback',
  unavailable: ['mail'],
  unavailableReasons: {},
  brief: {
    meetings: [],
    source: 'fallback',
    dayLine: '2026-06-15: 1 free block(s), 0 todo candidate(s).',
    gaps: [{ blockIndex: 0, start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T07:00:00.000Z' }],
    todos: [],
  },
  ...over,
} as BriefFile);

describe('BriefFile', () => {
  it('round-trips valid bytes with deterministic key order and a trailing newline', () => {
    const bytes = serializeBriefFile(file());
    const text = new TextDecoder().decode(bytes);
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseBriefFile(bytes);
    expect(parsed).toEqual(file());
    const first = Object.keys(JSON.parse(text));
    expect(first).toEqual(['schemaVersion', 'date', 'generatedAt', 'source', 'unavailable', 'unavailableReasons', 'brief']);
    const briefKeys = Object.keys(JSON.parse(text).brief);
    expect(briefKeys).toEqual(['source', 'dayLine', 'meetings', 'gaps', 'todos']);
  });

  it('keeps optional keys in stable positions when present', () => {
    const withOptional = file({
      brief: {
    meetings: [],
        source: 'model',
        dayLine: 'A quiet day.',
        stateLine: 'Steps are below your usual.',
        gaps: [{ blockIndex: 0, start: '2026-06-15T05:00:00.000Z', end: '2026-06-15T07:00:00.000Z', suggestion: 'Take a walk.' }],
        todos: [{ id: 0, text: 'Call the bank', due: '2026-06-15', bill: true, firstStep: 'Find the number.' }],
        encouragement: 'One step is enough.',
      },
      source: 'model',
    });
    const parsed = parseBriefFile(serializeBriefFile(file(withOptional as unknown as Record<string, unknown>)))!;
    expect(parsed.source).toBe('model');
    expect(parsed.brief.stateLine).toBe('Steps are below your usual.');
    expect(parsed.brief.gaps[0]!.suggestion).toBe('Take a walk.');
    expect(parsed.brief.todos[0]!.firstStep).toBe('Find the number.');
    expect(parsed.brief.encouragement).toBe('One step is enough.');
  });

  it.each([
    ['wrong schemaVersion', file({ schemaVersion: 3 })],
    ['invalid date', file({ date: '2026-02-30' })],
    ['invalid generatedAt', file({ generatedAt: 'yesterday' })],
    ['mismatched source', file({ source: 'model' })],
  ])('rejects %s', (_name, value) => {
    expect(parseBriefFile(value)).toBeNull();
  });

  it('parses JSON text and returns null for garbage without throwing', () => {
    expect(parseBriefFile(JSON.stringify(file()))).toEqual(file());
    expect(parseBriefFile('not json')).toBeNull();
    expect(parseBriefFile(null)).toBeNull();
  });
});

it('upgrades actual v1 JSON with defaults and keeps source consistency validation', () => {
  const legacy = { ...file(), schemaVersion: 1, unavailableReasons: undefined,
    brief: { ...file().brief, meetings: undefined } };
  expect(parseBriefFile(JSON.stringify(legacy))).toEqual(file());
  expect(parseBriefFile({ ...legacy, source: 'model' })).toBeNull();
});

it.each(['javascript:alert(1)', 'https://evil.test/calendar/event', 'https://www.google.com/other',
  'https://calendar.google.com.evil.test/event', 'https://calendar.google.com@evil.test/event', 'http://calendar.google.com/event'])('drops unsafe meeting link %s', (link) => {
  const input = file({ brief: { ...file().brief, meetings: [{ title: 'Synthetic', start: '2026-06-15T08:00:00Z',
    end: '2026-06-15T09:00:00Z', allDay: false, clash: false, link }] } });
  expect(parseBriefFile(input)?.brief.meetings[0]?.link).toBeUndefined();
  expect(new TextDecoder().decode(serializeBriefFile(input))).not.toContain(link);
});

it.each(['https://www.google.com/calendar/event?eid=synthetic', 'https://calendar.google.com/calendar/event?eid=synthetic'])('v2 round-trips byte-identically with a safe link %s', (link) => {
  const input = file({ unavailableReasons: { mail: 'threw' }, brief: { ...file().brief,
    meetings: [{ title: 'Synthetic', start: '2026-06-15T08:00:00Z', end: '2026-06-15T09:00:00Z', allDay: false, clash: true, clashWith: 'Synthetic B', link }],
    todos: [{ id: 0, text: 'Synthetic task', due: '2026-06-12', bill: false, overdueDays: 3 }],
  } });
  const bytes = serializeBriefFile(input);
  expect(serializeBriefFile(parseBriefFile(bytes)!)).toEqual(bytes);
  expect(parseBriefFile(bytes)?.brief.meetings[0]?.link).toBe(link);
});

it('defaults omitted v2 fields and rejects arbitrary error text or mismatched reason names', () => {
  expect(parseBriefFile({ ...file(), unavailableReasons: undefined, brief: { ...file().brief, meetings: undefined } })).toEqual(file());
  expect(parseBriefFile(file({ unavailableReasons: { mail: 'private error message' } }))).toBeNull();
  expect(parseBriefFile(file({ unavailableReasons: { calendar: 'threw' } }))).toBeNull();
});
