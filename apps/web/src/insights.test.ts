import type { ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { degradedReason, findingsTrend, overview, topPicks } from './insights.ts';

const status = (scoutId: string, extra: Partial<ScoutStatus> = {}): ScoutStatus => ({
  schemaVersion: 1, scoutId, displayName: scoutId, schedule: 'daily', expectedEveryHours: 24,
  lastAttemptAt: null, lastSuccessAt: null, runStatus: null, sources: null, aiHealth: null,
  findings: null, added: null, errors: null, lastError: null, latestOutput: null, history: [], ...extra,
});

describe('topPicks', () => {
  it('never yields a script, data or vbscript link (picks become href without a sanitiser)', () => {
    const picks = topPicks('- [a](javascript:alert(1))\n- [b](JAVASCRIPT:x)\n- [c](data:text/html,x)\n- [d](vbscript:x)\n');
    expect(picks.map((pick) => pick.link)).toEqual([undefined, undefined, undefined]);
  });
  it('takes three rows from the first regular table, preserving plain labels and the first row link', () => {
    const picks = topPicks('| Item | Place | Cost | Extra |\n| --- | --- | --- | --- |\n| [Tea](https://example.com/tea) | Market | 12 DKK | Today |\n| Coffee | Cafe | 30 DKK | Soon |\n| Bread | Bakery | 20 DKK | Friday |\n| Fourth | Elsewhere | 1 DKK | Later |');
    expect(picks).toEqual([
      { text: 'Tea', details: ['Place: Market', 'Cost: 12 DKK'], link: 'https://example.com/tea' },
      { text: 'Coffee', details: ['Place: Cafe', 'Cost: 30 DKK'], link: undefined },
      { text: 'Bread', details: ['Place: Bakery', 'Cost: 20 DKK'], link: undefined },
    ]);
  });

  it('rejects an uneven table and falls back to top-level list items with their first links', () => {
    const markdown = '| A | B |\n| --- | --- |\n| uneven |\n\n- [First](https://example.com/first) item\n  - Nested item\n- Second item [source](https://example.com/second)';
    expect(topPicks(markdown)).toEqual([
      { text: 'First item', details: [], link: 'https://example.com/first' },
      { text: 'Second item source', details: [], link: 'https://example.com/second' },
    ]);
  });

  it('stops at the end of the first top-level list, never mixing in a later unrelated list', () => {
    expect(topPicks('- First\n\nA paragraph.\n\n1. Unrelated later list').map((pick) => pick.text)).toEqual(['First']);
  });

  it('returns no picks when neither a regular table nor a top-level list is usable', () => {
    expect(topPicks('# Empty\n\nA paragraph only.')).toEqual([]);
    expect(topPicks('- One', 0)).toEqual([]);
  });

  it('uses list fallback when a table has an empty header like the scout renderer does', () => {
    expect(topPicks('| Item | |\n| --- | --- |\n| Ignored | value |\n\n- Usable fallback')).toEqual([
      { text: 'Usable fallback', details: [], link: undefined },
    ]);
  });
});

describe('findingsTrend', () => {
  it('uses Copenhagen calendar days across DST and only the last success per scout per day', () => {
    const statuses = [
      status('one', { history: [
        { at: '2026-03-28T22:30:00Z', status: 'success', findings: 1 },
        { at: '2026-03-28T23:30:00Z', status: 'success', findings: 2 },
        { at: '2026-03-29T21:30:00Z', status: 'success', findings: 5 },
        { at: '2026-03-30T22:30:00Z', status: 'success', findings: 0 },
      ] }),
      status('two', { history: [
        { at: '2026-03-29T08:00:00Z', status: 'success', findings: 3 },
        { at: '2026-03-29T20:00:00Z', status: 'failed', findings: 99 },
      ] }),
    ];
    expect(findingsTrend(statuses, '2026-03-31T12:00:00+02:00', 4)).toEqual([
      { date: '2026-03-28', findings: 1 },
      { date: '2026-03-29', findings: 8 },
      { date: '2026-03-30', findings: null },
      { date: '2026-03-31', findings: 0 },
    ]);
  });
});

describe('overview', () => {
  it('totals latest successful runs and excludes a failed scout with no success', () => {
    const good = status('good', { lastSuccessAt: '2026-09-27T07:00:00+02:00', runStatus: 'success', findings: 4 });
    const failed = status('failed', { lastAttemptAt: '2026-09-27T08:00:00+02:00', runStatus: 'failed', findings: 12 });
    const result = overview([good, failed]);
    expect(result.totalFindings).toBe(4);
    expect(result.latestSuccessAt).toBe('2026-09-27T07:00:00+02:00');
    expect(result.noSuccess).toEqual(['failed']);
    expect(result.byScout.has('failed')).toBe(false);
  });
});

describe('degraded runs count as results (B3)', () => {
  it('dates a degraded run with today\'s findings as today, not the older clean run', () => {
    const scout = status('daily-research', {
      lastAttemptAt: '2026-09-30T06:31:00+02:00',
      lastSuccessAt: '2026-09-29T07:00:00+02:00',
      runStatus: 'degraded',
      findings: 5,
      history: [{ at: '2026-09-29T07:00:00+02:00', status: 'success', findings: 3 }],
    });
    const result = overview([scout]);
    expect(result.totalFindings).toBe(5);
    expect(result.latestSuccessAt).toBe('2026-09-30T06:31:00+02:00');
    expect(result.byScout.get('daily-research')).toEqual({ findings: 5, at: '2026-09-30T06:31:00+02:00' });
    expect(result.noSuccess).toEqual([]);
    // The direct regression guard: a success-only `resultRuns` would report 3 yesterday instead.
    expect(findingsTrend([scout], '2026-09-30T12:00:00+02:00', 2)).toEqual([
      { date: '2026-09-29', findings: 3 },
      { date: '2026-09-30', findings: 5 },
    ]);
  });

  it('keeps a degraded zero honest as 0 rather than unknown', () => {
    const scout = status('quiet', { lastAttemptAt: '2026-09-30T06:00:00+02:00', runStatus: 'degraded', findings: 0 });
    expect(overview([scout]).byScout.get('quiet')).toEqual({ findings: 0, at: '2026-09-30T06:00:00+02:00' });
    expect(findingsTrend([scout], '2026-09-30T12:00:00+02:00', 1)).toEqual([{ date: '2026-09-30', findings: 0 }]);
  });

  it('fabricates nothing for failed, running, or evidence-free degraded runs', () => {
    const failed = status('failed', { lastAttemptAt: '2026-09-30T06:00:00+02:00', runStatus: 'failed', findings: 9 });
    const running = status('running', { lastAttemptAt: '2026-09-30T06:00:00+02:00', runStatus: 'running', findings: 4 });
    const empty = status('empty', { lastAttemptAt: '2026-09-30T06:00:00+02:00', runStatus: 'degraded', findings: null });
    const result = overview([failed, running, empty]);
    expect(result.totalFindings).toBe(0);
    expect(result.latestSuccessAt).toBeNull();
    expect(result.noSuccess.sort()).toEqual(['empty', 'failed', 'running']);
    expect(result.byScout.size).toBe(0);
    expect(findingsTrend([failed, running, empty], '2026-09-30T12:00:00+02:00', 1))
      .toEqual([{ date: '2026-09-30', findings: null }]);
  });

  it('picks the latest run of each day from mixed, unordered history', () => {
    const scout = status('mixed', { history: [
      { at: '2026-09-29T20:00:00Z', status: 'degraded', findings: 7 },
      { at: '2026-09-29T08:00:00Z', status: 'success', findings: 3 },
      { at: '2026-09-30T06:00:00Z', status: 'degraded', findings: 1 },
      { at: '2026-09-30T09:00:00Z', status: 'failed', findings: 99 },
    ] });
    expect(overview([scout]).byScout.get('mixed')).toEqual({ findings: 1, at: '2026-09-30T06:00:00Z' });
    expect(findingsTrend([scout], '2026-09-30T12:00:00+02:00', 2)).toEqual([
      { date: '2026-09-29', findings: 7 },
      { date: '2026-09-30', findings: 1 },
    ]);
  });

  it('falls back to lastSuccessAt as the run timestamp when an attempt time is missing', () => {
    const scout = status('late', { runStatus: 'degraded', findings: 3, lastSuccessAt: '2026-09-30T06:00:00+02:00' });
    expect(overview([scout]).byScout.get('late')).toEqual({ findings: 3, at: '2026-09-30T06:00:00+02:00' });
  });

  it('never mutates the input statuses', () => {
    const scout = status('stable', {
      lastAttemptAt: '2026-09-30T06:00:00+02:00', runStatus: 'degraded', findings: 2,
      history: [{ at: '2026-09-29T06:00:00+02:00', status: 'success', findings: 1 }],
    });
    const before = JSON.stringify(scout);
    overview([scout]);
    findingsTrend([scout], '2026-09-30T12:00:00+02:00');
    expect(JSON.stringify(scout)).toBe(before);
  });
});

describe('degradedReason', () => {
  it('prefers the failed-source count over the last error', () => {
    expect(degradedReason(status('s', { sources: { configured: 8, successful: 3 }, lastError: 'raw' })))
      .toBe('5 sources failed');
    expect(degradedReason(status('s', { sources: { configured: 2, successful: 1 } }))).toBe('1 source failed');
    expect(degradedReason(status('s', { sources: { configured: 3, successful: 3 }, lastError: 'raw' }))).toBe('raw');
  });

  it('flattens the last error to one bounded plain line', () => {
    expect(degradedReason(status('s', { lastError: 'boom\nsecond\tline  ' }))).toBe('boom second line');
    const long = degradedReason(status('s', { lastError: 'x'.repeat(400) }))!;
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('\u2026')).toBe(true);
    expect(degradedReason(status('s'))).toBeNull();
  });
});
