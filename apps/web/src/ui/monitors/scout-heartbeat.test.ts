import { ScoutsResponse, type ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { scoutHeartbeat } from './scout-heartbeat.ts';

const TZ = 'Europe/Copenhagen';
const NOW = '2026-10-16T09:41:00Z'; // 11:41 in Copenhagen (+02:00): today is local 16 Oct.
const REV = 'a'.repeat(40);

const status = (over: Partial<ScoutStatus> = {}): ScoutStatus => ({
  schemaVersion: 1, scoutId: 'scout', displayName: 'Scout', schedule: null, expectedEveryHours: 24,
  lastAttemptAt: '2026-10-16T06:31:00Z', lastSuccessAt: '2026-10-16T06:31:00Z', runStatus: 'success',
  sources: null, aiHealth: null, findings: null, added: null, errors: null, lastError: null, latestOutput: null,
  history: [], ...over,
});
const scout = (id: string, over: Partial<ScoutStatus> = {}) =>
  ({ state: 'ok' as const, file: `${id}.json`, status: status({ scoutId: id, displayName: id, ...over }) });
const response = (...scouts: unknown[]) => ScoutsResponse.parse({ revision: REV, now: NOW, scouts });

describe('scoutHeartbeat counts and summary', () => {
  it('counts each state and drops zero parts from the summary', () => {
    const view = scoutHeartbeat(response(
      scout('alpha'),
      scout('beta'),
      scout('gamma', { runStatus: 'degraded' }),
      scout('delta', { runStatus: 'failed' }),
    ), TZ);
    expect(view.counts).toEqual({ ok: 2, degraded: 1, failed: 1, stale: 0 });
    expect(view.summary).toBe('2 ok \u00b7 1 degraded \u00b7 1 failed');
    expect(view.rows).toHaveLength(4);
  });

  it('calls a scout stale past 1.25x its cadence and counts it in the summary', () => {
    const view = scoutHeartbeat(response(
      scout('fresh'),
      scout('lagging', { lastAttemptAt: '2026-10-14T17:41:00Z', lastSuccessAt: '2026-10-14T17:41:00Z' }), // 40 h ago
    ), TZ);
    expect(view.rows[1]!.state).toBe('stale');
    expect(view.rows[1]!.last).toBe('2 d ago');
    expect(view.counts).toEqual({ ok: 1, degraded: 0, failed: 0, stale: 1 });
    expect(view.summary).toBe('1 ok \u00b7 1 stale');
  });
});

describe('scoutHeartbeat day cells', () => {
  it('keeps the worst run of a day, leaves empty days none, and buckets by the local day', () => {
    const view = scoutHeartbeat(response(scout('alpha', { history: [
      { at: '2026-10-14T05:00:00Z', status: 'success', findings: null },
      { at: '2026-10-14T06:00:00Z', status: 'failed', findings: null },
      { at: '2026-10-15T22:30:00Z', status: 'success', findings: null },
    ] })), TZ);
    const cells = view.rows[0]!.cells;
    expect(cells).toHaveLength(14);
    expect(cells[10]).toBe('none'); // 13 Oct: a day without runs is never invented
    expect(cells[11]).toBe('failed'); // 14 Oct: success + failed -> the worst wins
    expect(cells[12]).toBe('none'); // 15 Oct
    expect(cells[13]).toBe('ok'); // the 22:30Z run lands on local 16 Oct (+02:00)
  });
});

describe('scoutHeartbeat honesty', () => {
  it('renders an unreadable file as a failed row', () => {
    const view = scoutHeartbeat(response(scout('alpha'), { state: 'unreadable', file: 'broken.json' }), TZ);
    expect(view.rows).toHaveLength(2);
    expect(view.rows[1]).toMatchObject({ id: 'broken.json', name: 'broken.json', state: 'failed', last: '\u2014' });
    expect(view.counts.failed).toBe(1);
  });

  it('says all healthy when every scout is ok, and dates the freshness line from res.now', () => {
    const view = scoutHeartbeat(response(scout('alpha'), scout('beta')), TZ);
    expect(view.summary).toBe('2 ok \u00b7 all healthy');
    expect(view.freshness).toBe('Scout status files \u00b7 Updated 11:41');
    expect(view.rows[0]!.last).toBe('08:31');
  });
});
