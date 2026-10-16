// LB1 presentation tests: every assertion names the pure helper it guards.
import { describe, expect, it } from 'vitest';
import type { LeaderboardModel, LeaderboardResponse, LeaderboardMovement } from '@vault-companion/contracts';
import {
  barRatio,
  benchmarkMeta,
  formatBenchmark,
  formatScore,
  leaderboardCategories,
  leaderboardFresh,
  leaderboardNote,
  leaderboardRows,
  movementLabel,
  specRows,
  strongestCapability,
} from './leaderboard.ts';

const baseModel = (slug: string, name: string, provider: string | null, scores: Partial<LeaderboardModel['scores']>, movement: LeaderboardMovement | null = null, extra: Partial<LeaderboardModel> = {}): LeaderboardModel => ({
  slug,
  name,
  provider,
  scores: { overall: scores.overall ?? null, coding: scores.coding ?? null, agentic: scores.agentic ?? null, math: scores.math ?? null },
  benchmarks: [],
  pricingInputPer1M: null,
  pricingOutputPer1M: null,
  medianTokensPerSecond: null,
  medianTimeToFirstTokenSeconds: null,
  releaseDate: null,
  contextWindowTokens: null,
  openWeights: null,
  reasoningModel: null,
  inputModalities: [],
  outputModalities: [],
  movement,
  ...extra,
});

const SYNCED = '2026-10-15T06:30:00.000Z';


describe('leaderboardCategories', () => {
  it('lists only categories with a ranking, in fixed order', () => {
    const response: LeaderboardResponse = {
      status: 'ok', now: SYNCED, syncedAt: SYNCED, provenance: 'p', intelligenceIndexVersion: null, note: null,
      models: [],
      rankings: { overall: ['a'], coding: ['a'], agentic: [], math: [] },
    };
    expect(leaderboardCategories(response)).toEqual(['overall', 'coding']);
  });
  it('is empty for an unavailable response', () => {
    const response: LeaderboardResponse = { status: 'unavailable', now: SYNCED, reason: 'no-key', note: 'n' };
    expect(leaderboardCategories(response)).toEqual([]);
  });
});

describe('leaderboardRows', () => {
  it('ranks rows from the category ranking and skips entries without payload', () => {
    const alpha = baseModel('alpha', 'Alpha', 'Test Labs', { overall: 70 });
    const beta = baseModel('beta', 'Beta', 'Test Labs', { overall: 60 });
    const response: LeaderboardResponse = {
      status: 'ok', now: SYNCED, syncedAt: SYNCED, provenance: 'p', intelligenceIndexVersion: null, note: null,
      models: [alpha, beta],
      rankings: { overall: ['alpha', 'ghost', 'beta'], coding: [], agentic: [], math: [] },
    };
    const rows = leaderboardRows(response, 'overall');
    expect(rows.map((r) => [r.rank, r.model.slug, r.score])).toEqual([[1, 'alpha', 70], [3, 'beta', 60]]);
  });
});

describe('formatScore / formatBenchmark', () => {
  it('renders index scores with one decimal and missing ones as a dash', () => {
    expect(formatScore(71.44)).toBe('71.4');
    expect(formatScore(null)).toBe('—');
  });
  it('renders mixed-scale benchmark values close to how they are published', () => {
    expect(formatBenchmark(0.791)).toBe('79%');
    expect(formatBenchmark(681)).toBe('681');
    expect(formatBenchmark(12.5)).toBe('12.5');
    expect(formatBenchmark(50.0)).toBe('50');
  });
});

describe('movementLabel', () => {
  it('labels climbs, falls, new entries, unchanged and absent movement', () => {
    expect(movementLabel({ rankDelta: 2, isNew: false })).toBe('↑ 2');
    expect(movementLabel({ rankDelta: -1, isNew: false })).toBe('↓ 1');
    expect(movementLabel({ rankDelta: 0, isNew: true })).toBe('New');
    expect(movementLabel({ rankDelta: 0, isNew: false })).toBeNull();
    expect(movementLabel(null)).toBeNull();
  });
});

describe('strongestCapability', () => {
  it('picks the best present category; null when none is scored', () => {
    expect(strongestCapability(baseModel('a', 'A', null, { coding: 40, agentic: 60, math: 50 }))).toBe('Agentic');
    expect(strongestCapability(baseModel('a', 'A', null, { overall: 70 }))).toBeNull();
  });
});

describe('barRatio', () => {
  it('scales against the best score in view and clamps to a sliver..1', () => {
    expect(barRatio(50, 100)).toBe(0.5);
    expect(barRatio(null, 100)).toBe(0);
    expect(barRatio(1, 100)).toBe(0.04);
    expect(barRatio(150, 100)).toBe(1);
  });
});

describe('leaderboardFresh / leaderboardNote', () => {
  const ok: LeaderboardResponse = {
    status: 'ok', now: SYNCED, syncedAt: SYNCED, provenance: 'p', intelligenceIndexVersion: null, note: null,
    models: [], rankings: { overall: [], coding: [], agentic: [], math: [] },
  };
  it('is fresh within the window and stale past it', () => {
    const syncedMs = Date.parse(SYNCED);
    expect(leaderboardFresh(ok, syncedMs + 25 * 60 * 60 * 1000)).toBe(true);
    expect(leaderboardFresh(ok, syncedMs + 27 * 60 * 60 * 1000)).toBe(false);
  });
  it('carries the plain reason note for an unavailable response', () => {
    const response: LeaderboardResponse = { status: 'unavailable', now: SYNCED, reason: 'provider-error', note: 'The benchmark provider is unavailable right now.' };
    expect(leaderboardNote(response)).toContain('provider is unavailable');
  });
});

describe('specRows', () => {
  it('lists only specs that exist, formatted for humans', () => {
    const model = baseModel('a', 'A', 'Anthropic', {}, null, {
      releaseDate: '2025-11-01',
      contextWindowTokens: 200000,
      pricingInputPer1M: 3,
      pricingOutputPer1M: 15,
      medianTokensPerSecond: 95.4,
      openWeights: false,
    });
    const rows = specRows(model).map((r) => r.label);
    expect(rows).toEqual(['Provider', 'Released', 'Weights', 'Context window', 'Input price', 'Output price', 'Speed']);
  });
  it('shows nothing for a bare free-tier row', () => {
    expect(specRows(baseModel('a', 'A', null, {}))).toEqual([]);
  });
});

describe('benchmarkMeta', () => {
  it('explains a known benchmark and labels an unknown one honestly', () => {
    expect(benchmarkMeta('gpqa_diamond').label).toBe('GPQA Diamond');
    expect(benchmarkMeta('brand_new_eval').label).toBe('brand_new_eval');
    expect(benchmarkMeta('brand_new_eval').explainer).toContain('no description');
  });
});
