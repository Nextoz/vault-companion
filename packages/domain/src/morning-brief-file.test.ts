import { describe, expect, it } from 'vitest';
import { parseBriefFile, serializeBriefFile, type BriefFile } from './morning-brief-file.ts';

const file = (over: Record<string, unknown> = {}): BriefFile => ({
  schemaVersion: 1,
  date: '2026-06-15',
  generatedAt: '2026-06-15T04:30:05.000Z',
  source: 'fallback',
  unavailable: ['mail'],
  brief: {
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
    expect(first).toEqual(['schemaVersion', 'date', 'generatedAt', 'source', 'unavailable', 'brief']);
    const briefKeys = Object.keys(JSON.parse(text).brief);
    expect(briefKeys).toEqual(['source', 'dayLine', 'gaps', 'todos']);
  });

  it('keeps optional keys in stable positions when present', () => {
    const withOptional = file({
      brief: {
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
    ['wrong schemaVersion', file({ schemaVersion: 2 })],
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
