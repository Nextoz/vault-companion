import { describe, expect, it } from 'vitest';
import type { ScoutStatus, ScoutsResponse } from '@vault-companion/contracts';
import { attentionCount, displayState, lastRun, relativeTime } from './scouts.ts';

const at = '2026-09-27T04:50:02Z';
const healthy: ScoutStatus = {
  schemaVersion: 1, scoutId: 'learning', displayName: 'Learning', schedule: 'daily', expectedEveryHours: 24,
  lastAttemptAt: at, lastSuccessAt: at, runStatus: 'success', sources: { configured: 2, successful: 2 },
  aiHealth: 'healthy', findings: 0, added: 0, errors: 0, lastError: null, latestOutput: 'Notes/Learning.md', history: [],
};
const now = Date.parse(at) + 2 * 3_600_000;
describe('displayState', () => {
  it.each([
    ['success', 'Healthy'], ['failed', 'Failed'], ['degraded', 'Degraded'],
  ] as const)('maps %s', (runStatus, expected) => {
    expect(displayState({ ...healthy, runStatus }, now)).toBe(expected);
  });
  it('running requires an attempt newer than success, including a first attempt', () => {
    expect(displayState({ ...healthy, runStatus: 'running', lastSuccessAt: null }, now)).toBe('Running');
    expect(displayState({ ...healthy, runStatus: 'running', lastSuccessAt: '2026-09-26T04:00:00Z' }, now)).toBe('Running');
    expect(displayState({ ...healthy, runStatus: 'running' }, now)).toBe('No status yet');
    expect(displayState({ ...healthy, runStatus: 'running', lastAttemptAt: null }, now)).toBe('No status yet');
  });
  it.each(['success', 'running', 'failed', 'degraded'] as const)('stale overrides %s strictly after the boundary', (runStatus) => {
    const status = { ...healthy, runStatus, lastSuccessAt: '2026-09-26T04:00:00Z' };
    const boundary = Date.parse(at) + 31 * 3_600_000;
    expect(displayState(status, boundary)).not.toBe('Stale');
    expect(displayState(status, boundary + 1)).toBe('Stale');
    expect(displayState({ ...status, expectedEveryHours: null }, boundary + 1)).not.toBe('Stale');
  });
  it('missing status and dates never appear green', () => {
    expect(displayState(null, now)).toBe('No status yet');
    for (const field of ['runStatus', 'lastAttemptAt', 'lastSuccessAt'] as const) {
      expect(displayState({ ...healthy, [field]: null }, now)).toBe('No status yet');
    }
    expect(displayState({ ...healthy, runStatus: null, lastAttemptAt: null, lastSuccessAt: null, findings: null, sources: null, aiHealth: null }, now)).toBe('No status yet');
  });
  it('zero findings on a successful run is Healthy', () => {
    expect(displayState(healthy, now)).toBe('Healthy');
  });
});
it('relative time and newer failed attempts', () => {
  expect(relativeTime(at, now)).toBe('2 h ago');
  expect(relativeTime(at, Date.parse(at) + 60_000)).toBe('1 min ago');
  expect(relativeTime(at, at)).toBe('just now');
  expect(relativeTime(at, Date.parse(at) + 86_400_000)).toBe('1 d ago');
  expect(relativeTime(null, now)).toBe('—');
  expect(lastRun({ ...healthy, runStatus: 'failed', lastSuccessAt: '2026-09-26T04:00:00Z' })).toBe(at);
  expect(lastRun({ ...healthy, lastAttemptAt: null, lastSuccessAt: null })).toBeNull();
});
it('only Failed and Stale need attention; unreadable is neutral', () => {
  const response: ScoutsResponse = { revision: 'a'.repeat(40), now: new Date(now).toISOString(), scouts: [
    ...(['success', 'failed', 'degraded', 'running'] as const).map((runStatus) => ({ state: 'ok' as const, file: runStatus, status: { ...healthy, runStatus } })),
    { state: 'ok', file: 'stale', status: { ...healthy, lastAttemptAt: '2026-09-20T04:00:00Z' } },
    { state: 'unreadable', file: 'bad.json' },
  ] };
  expect(attentionCount(response)).toBe(2);
  expect(attentionCount({ ...response, scouts: [] })).toBe(0);
});
