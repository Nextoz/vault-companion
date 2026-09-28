import type { ScoutStatus } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { findingsTrend, overview, topPicks } from './insights.ts';

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
