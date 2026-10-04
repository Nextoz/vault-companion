import { describe, expect, it } from 'vitest';
import { HealthResponse, MorningBriefResponse, MorningResponse, ScoutsResponse } from '@vault-companion/contracts';
import {
  SIWH_MAX_LINES,
  establishBaseline,
  latestSuccessfulFindings,
  parseSinceIWasHereSnapshot,
  sameSnapshot,
  scoutFindings,
  sinceIWasHereFacts,
  sinceIWasHereLines,
  snapshotOf,
  type SiwhFacts,
  type SiwhSnapshot,
} from './since-i-was-here.ts';

const facts = (over: Partial<SiwhFacts> = {}): SiwhFacts => ({
  triage: 0,
  scouts: [],
  brief: null,
  papers: [],
  health: null,
  ...over,
});

describe('sinceIWasHereLines', () => {
  it('shows nothing on a first install (no snapshot at all)', () => {
    expect(sinceIWasHereLines(facts({ triage: 3, scouts: [{ id: 'learning', name: 'Learning', findings: 4 }], brief: '2026-09-30', papers: ['a'] }), null)).toEqual([]);
  });

  it('shows no line when a source is unchanged', () => {
    const snapshot: SiwhSnapshot = { at: 1, triage: 2, scouts: { learning: 4 }, brief: '2026-09-30', papers: ['a', 'b'] };
    expect(sinceIWasHereLines(facts({ triage: 2, scouts: [{ id: 'learning', name: 'Learning', findings: 4 }], brief: '2026-09-30', papers: ['a', 'b'] }), snapshot)).toEqual([]);
  });

  it('shows no line and no fake zero when a source is unavailable', () => {
    const snapshot: SiwhSnapshot = { at: 1, triage: 4, papers: ['a'], health: '2026-09-29' };
    const lines = sinceIWasHereLines(facts({ triage: null, papers: null, health: null }), snapshot);
    expect(lines).toEqual([]);
    expect(lines.some((line) => /0\b/.test(line.text))).toBe(false);
  });

  it('shows a line when triage cards were added', () => {
    const lines = sinceIWasHereLines(facts({ triage: 3 }), { at: 1, triage: 0 });
    expect(lines).toEqual([{ id: 'triage', text: '3 events in triage', target: 'triage' }]);
  });

  it('never shows a decrease (fewer triage cards) as new', () => {
    expect(sinceIWasHereLines(facts({ triage: 1 }), { at: 1, triage: 3 })).toEqual([]);
  });

  it('shows a scout line only when its newest successful run has more findings', () => {
    const scouts = [{ id: 'learning', name: 'Learning opportunities', findings: 4 }];
    expect(sinceIWasHereLines(facts({ scouts }), { at: 1, scouts: { learning: 1 } }))
      .toEqual([{ id: 'scout:learning', text: 'Learning opportunities \u00b7 3 new findings', target: 'scouts' }]);
    expect(sinceIWasHereLines(facts({ scouts }), { at: 1, scouts: { learning: 4 } })).toEqual([]);
    expect(sinceIWasHereLines(facts({ scouts }), { at: 1, scouts: { learning: 9 } })).toEqual([]);
    // A scout the device never saw before is a baseline, not an announcement.
    expect(sinceIWasHereLines(facts({ scouts }), { at: 1, scouts: {} })).toEqual([]);
  });

  it('announces a new morning brief and newly explained papers, never a removal', () => {
    expect(sinceIWasHereLines(facts({ brief: '2026-09-30' }), { at: 1, brief: '2026-09-29' }))
      .toEqual([{ id: 'brief', text: 'New morning brief', target: 'papers' }]);
    expect(sinceIWasHereLines(facts({ brief: '2026-09-30' }), { at: 1, brief: '2026-09-30' })).toEqual([]);
    expect(sinceIWasHereLines(facts({ papers: ['a', 'b'] }), { at: 1, papers: ['a'] }))
      .toEqual([{ id: 'papers', text: '1 new explained paper', target: 'papers' }]);
    expect(sinceIWasHereLines(facts({ papers: ['a'] }), { at: 1, papers: ['a', 'b'] })).toEqual([]);
  });

  it('announces a health day only when the date moved forward', () => {
    expect(sinceIWasHereLines(facts({ health: '2026-09-30' }), { at: 1, health: '2026-09-29' }))
      .toEqual([{ id: 'health', text: 'New health day', target: 'health' }]);
    expect(sinceIWasHereLines(facts({ health: '2026-09-29' }), { at: 1, health: '2026-09-29' })).toEqual([]);
    expect(sinceIWasHereLines(facts({ health: '2026-09-28' }), { at: 1, health: '2026-09-29' })).toEqual([]);
    expect(sinceIWasHereLines(facts({ health: '2026-09-30' }), { at: 1 })).toEqual([]);
  });

  it('never renders more than five lines', () => {
    const scouts = Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, name: `Scout ${index}`, findings: 3 }));
    const seen = Object.fromEntries(scouts.map((scout) => [scout.id, 1]));
    const lines = sinceIWasHereLines(
      facts({ triage: 2, scouts, brief: '2026-09-30', papers: ['x', 'y'], health: '2026-09-30' }),
      { at: 1, triage: 0, scouts: seen, brief: '2026-09-29', papers: [], health: '2026-09-28' },
    );
    expect(lines).toHaveLength(SIWH_MAX_LINES);
  });
});

describe('snapshotOf', () => {
  it('stores every current source and records the time', () => {
    const snapshot = snapshotOf(facts({ triage: 2, scouts: [{ id: 'learning', name: 'Learning', findings: 4 }], brief: '2026-09-30', papers: ['a'], health: '2026-09-30' }), null, 42);
    expect(snapshot).toEqual({ at: 42, triage: 2, scouts: { learning: 4 }, brief: '2026-09-30', papers: ['a'], health: '2026-09-30' });
  });

  it('keeps the last seen value for a source that is unavailable at close', () => {
    const snapshot = snapshotOf(facts({ triage: null, scouts: null, papers: null, health: null }), { at: 1, triage: 5, papers: ['a'], health: '2026-09-28' }, 42);
    expect(snapshot).toEqual({ at: 42, triage: 5, papers: ['a'], health: '2026-09-28' });
  });
});

describe('establishBaseline', () => {
  it('records sources the device has never seen without advancing ones it has', () => {
    const stored: SiwhSnapshot = { at: 1, triage: 1 };
    const merged = establishBaseline(stored, facts({ triage: 9, scouts: [{ id: 'learning', name: 'Learning', findings: 4 }], papers: ['a'] }), 42);
    expect(merged.triage).toBe(1);
    expect(merged.scouts).toEqual({ learning: 4 });
    expect(merged.papers).toEqual(['a']);
    expect(merged.at).toBe(1);
  });

  it('establishes the whole baseline on a first install', () => {
    expect(establishBaseline(null, facts({ triage: 0, papers: [] }), 7)).toEqual({ at: 7, triage: 0, scouts: {}, papers: [] });
  });

  it('is idempotent, so a render never loops', () => {
    const merged = establishBaseline(null, facts({ triage: 0 }), 7);
    expect(sameSnapshot(merged, establishBaseline(merged, facts({ triage: 0 }), 99))).toBe(true);
  });
});

describe('parseSinceIWasHereSnapshot', () => {
  it('round-trips a snapshot and rejects a malformed one', () => {
    const snapshot: SiwhSnapshot = { at: 5, triage: 3, scouts: { learning: 4 }, brief: '2026-09-30', papers: ['a'], health: '2026-09-30' };
    expect(parseSinceIWasHereSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(parseSinceIWasHereSnapshot(null)).toBeNull();
    expect(parseSinceIWasHereSnapshot('not json')).toBeNull();
    expect(parseSinceIWasHereSnapshot('[]')).toBeNull();
    expect(parseSinceIWasHereSnapshot('{"at":"x"}')).toBeNull();
    expect(parseSinceIWasHereSnapshot('{"at":1,"papers":[1]}')).toBeNull();
  });
});

const scoutStatus = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, scoutId: 'learning', displayName: 'Learning opportunities', schedule: 'daily 07:00', expectedEveryHours: 24,
  lastAttemptAt: '2026-09-27T07:00:00+02:00', lastSuccessAt: '2026-09-27T07:00:00+02:00', runStatus: 'success',
  sources: { configured: 3, successful: 3 }, aiHealth: 'healthy', findings: 4, added: 2, errors: 0, lastError: null,
  latestOutput: 'Discoveries/Learning.md',
  history: [
    { at: '2026-09-26T07:00:00+02:00', status: 'degraded', findings: 2 },
    { at: '2026-09-27T07:00:00+02:00', status: 'success', findings: 4 },
  ],
  ...over,
});

describe('scoutFindings', () => {
  it('takes the newest successful run and skips unreadable or never-succeeded scouts', () => {
    const response = ScoutsResponse.parse({
      revision: 'a'.repeat(40), now: '2026-09-27T08:00:00+02:00', scouts: [
        { state: 'ok', file: 'learning.json', status: scoutStatus() },
        { state: 'ok', file: 'failed.json', status: scoutStatus({ scoutId: 'failed', displayName: 'Failed', runStatus: 'failed', findings: null, history: [{ at: '2026-09-27T07:00:00+02:00', status: 'failed', findings: null }] }) },
        { state: 'unreadable', file: 'unreadable.json' },
      ],
    });
    expect(scoutFindings(response)).toEqual([{ id: 'learning', name: 'Learning opportunities', findings: 4 }]);
  });

  it('falls back to the status findings only when the run itself succeeded', () => {
    expect(latestSuccessfulFindings(scoutStatus({ history: [] }) as never)).toBe(4);
    expect(latestSuccessfulFindings(scoutStatus({ runStatus: 'degraded', findings: 9, history: [] }) as never)).toBeNull();
  });
});

describe('sinceIWasHereFacts', () => {
  it('narrows the Today reads to counts and keys, ignoring a stale brief and unreadable papers', () => {
    const scouts = ScoutsResponse.parse({ revision: 'a'.repeat(40), now: '2026-09-27T08:00:00+02:00', scouts: [
      { state: 'ok', file: 'learning.json', status: scoutStatus() },
    ] });
    const brief = MorningBriefResponse.parse({ revision: 'b'.repeat(40), date: '2026-09-30', generatedAt: '2026-09-30T04:31:00+02:00', source: 'fallback', unavailable: [], brief: { source: 'fallback', dayLine: 'Day', gaps: [], todos: [] } });
    const morning = MorningResponse.parse({ revision: 'a'.repeat(40), date: '2026-09-30', brief: null, explained: [
      { status: 'ok', revision: 'a'.repeat(40), path: 'Research/Explained/a.md', blobSha: 'c'.repeat(40), markdown: '# A' },
      { status: 'refused', revision: 'a'.repeat(40), code: 'not-found', message: 'missing' },
    ] });
    const health = HealthResponse.parse({ revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'ok', day: '2026-09-30', staleDays: 0, metrics: [] });
    expect(sinceIWasHereFacts({ triage: 3, scouts, brief, morning, health, today: '2026-09-30' }))
      .toEqual({ triage: 3, scouts: [{ id: 'learning', name: 'Learning opportunities', findings: 4 }], brief: '2026-09-30', papers: ['Research/Explained/a.md'], health: '2026-09-30' });
    expect(sinceIWasHereFacts({ triage: null, scouts: null, brief, morning, health, today: '2026-10-01' }).brief).toBeNull();
    expect(sinceIWasHereFacts({ triage: null, scouts: null, brief: null, morning: null, health: null, today: '2026-09-30' }))
      .toEqual({ triage: null, scouts: null, brief: null, papers: null, health: null });
    const missing = HealthResponse.parse({ revision: 'a'.repeat(40), now: '2026-09-30T12:00:00Z', status: 'missing', metrics: [] });
    expect(sinceIWasHereFacts({ triage: null, scouts: null, brief: null, morning: null, health: missing, today: '2026-09-30' }).health).toBeNull();
  });
});
