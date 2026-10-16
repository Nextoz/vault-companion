// LB1 tests. Fixtures follow the provider's documented response shape (their published examples: the o3-mini list
// row and the gpt-oss-20b detail row); extra rows exist only to make ties, nulls and movement testable.
import { describe, expect, it, vi } from 'vitest';
import {
  applyMovement,
  buildLeaderboard,
  createLeaderboardSource,
  LEADERBOARD_TTL_MS,
  leaderboardUrl,
  parseAaBody,
  parseAaModel,
} from './leaderboard.ts';

const aaRow = (slug: string, name: string, provider: string, evaluations: Record<string, number | null>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug,
  name,
  model_creator: { name: provider },
  evaluations,
  ...extra,
});
const aaBody = (data: unknown[], version = 4.3): unknown => ({ tier: 'free', intelligence_index_version: version, data });
const providerJson = (body: unknown): typeof fetch => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

// Values in the two rows below come from the provider's published documentation examples.
const O3_MINI = aaRow('o3-mini', 'o3-mini', 'OpenAI', {
  artificial_analysis_intelligence_index: 62.9,
  artificial_analysis_coding_index: 55.8,
  artificial_analysis_math_index: 87.2,
  mmlu_pro: 0.791,
  gpqa: 0.748,
  hle: 0.087,
  livecodebench: 0.717,
  scicode: 0.399,
  math_500: 0.973,
  aime: 0.77,
}, {
  pricing: { price_1m_input_tokens: 1.1, price_1m_output_tokens: 4.4 },
  performance: { median_output_tokens_per_second: 153.831, median_time_to_first_token_seconds: 14.939 },
});

const GPT_OSS_20B = aaRow('gpt-oss-20b', 'gpt-oss-20B (high)', 'OpenAI', {
  artificial_analysis_intelligence_index: 24.5,
  artificial_analysis_coding_index: 18.5,
  artificial_analysis_agentic_index: 27.6,
  tau2_telecom: 0.6,
  tau_banking: 0.61,
  terminalbench_v2_1: 0.22,
  scicode: 0.34,
  aa_lcr: 0.31,
  ifbench: 0.65,
  hle: 0.1,
  gpqa_diamond: 0.69,
  critpt: 0.01,
  gdpval_aa_elo: 681,
  gdpval_aa_normalized: 0.09,
  mmmu_pro: null,
}, {
  release_date: '2025-08-05',
  reasoning_model: true,
  context_window_tokens: 131072,
  licensing: { is_open_weights: true },
  modalities: { input: { text: true, image: false }, output: { text: true } },
  pricing: { price_1m_input_tokens: 0.06, price_1m_output_tokens: 0.2 },
  performance: { median_output_tokens_per_second: 296.47, median_time_to_first_token_seconds: 0.65 },
});

const CLAUDE_X = aaRow('claude-x', 'Claude X', 'Anthropic', {
  artificial_analysis_intelligence_index: 71.4,
  artificial_analysis_coding_index: 62.1,
  artificial_analysis_agentic_index: 55.0,
  artificial_analysis_math_index: 91.3,
  gpqa_diamond: 0.82,
  livecodebench: 0.78,
});
const GEMINI_Y = aaRow('gemini-y', 'Gemini Y', 'Google', {
  artificial_analysis_intelligence_index: 66.7,
  artificial_analysis_coding_index: 60.4,
  artificial_analysis_math_index: 89.0,
});
const TIE_A = aaRow('tie-a', 'Tie A', 'Tie Labs', { artificial_analysis_intelligence_index: 50.0 });
const TIE_B = aaRow('tie-b', 'Tie B', 'Tie Labs', { artificial_analysis_intelligence_index: 50.0 });
const CODING_ONLY = aaRow('coding-only', 'Coding Only', 'Test Labs', { artificial_analysis_coding_index: 45.0 });
const DAY_ONE = [CLAUDE_X, GEMINI_Y, O3_MINI, GPT_OSS_20B, TIE_A, TIE_B, CODING_ONLY];

describe('parseAaModel', () => {
  it('maps a documented provider row, keeping absent scores as null', () => {
    const model = parseAaModel(GPT_OSS_20B);
    expect(model).not.toBeNull();
    expect(model?.scores.overall).toBe(24.5);
    expect(model?.scores.math).toBeNull();
    expect(model?.openWeights).toBe(true);
    expect(model?.contextWindowTokens).toBe(131072);
    expect(model?.releaseDate).toBe('2025-08-05');
    expect(model?.inputModalities).toEqual(['text']);
    expect(model?.benchmarks).toContainEqual({ key: 'gdpval_aa_elo', value: 681 });
    expect(model?.benchmarks.map((b) => b.key)).not.toContain('artificial_analysis_intelligence_index');
  });
  it('drops rows without a slug, a name or any headline score', () => {
    expect(parseAaModel(null)).toBeNull();
    expect(parseAaModel({ slug: 'x', name: 'X', evaluations: {} })).toBeNull();
    expect(parseAaModel({ slug: 'x', evaluations: { artificial_analysis_intelligence_index: 50 } })).toBeNull();
  });
});

describe('parseAaBody', () => {
  it('takes the documented envelope and its index version', () => {
    expect(parseAaBody(aaBody([O3_MINI]))?.intelligenceIndexVersion).toBe(4.3);
  });
  it('refuses envelopes without a data array', () => {
    expect(parseAaBody({ tier: 'free' })).toBeNull();
    expect(parseAaBody({ data: 'nope' })).toBeNull();
  });
});

describe('buildLeaderboard', () => {
  it('ranks by score descending and breaks ties by name', () => {
    const build = buildLeaderboard(parseAaBody(aaBody(DAY_ONE))!.models);
    expect(build.rankings.overall).toEqual(['claude-x', 'gemini-y', 'o3-mini', 'tie-a', 'tie-b', 'gpt-oss-20b']);
    expect(build.rankings.coding).toEqual(['claude-x', 'gemini-y', 'o3-mini', 'coding-only', 'gpt-oss-20b']);
  });
  it('excludes a model from a category ranking when that score is missing', () => {
    const build = buildLeaderboard(parseAaBody(aaBody(DAY_ONE))!.models);
    expect(build.rankings.overall).not.toContain('coding-only');
    expect(build.rankings.math).not.toContain('gpt-oss-20b');
  });
  it('unions every category into the payload, overall ranking first', () => {
    const build = buildLeaderboard(parseAaBody(aaBody(DAY_ONE))!.models);
    expect(build.models[0]?.slug).toBe('claude-x');
    expect(build.models.map((m) => m.slug)).toContain('coding-only');
  });
});

describe('applyMovement', () => {
  const models = parseAaBody(aaBody(DAY_ONE))!.models;
  it('marks climbs, falls and unchanged ranks', () => {
    const moved = applyMovement(models.slice(0, 3), ['gemini-y', 'claude-x', 'o3-mini'], ['claude-x', 'o3-mini', 'gemini-y']);
    const bySlug = new Map(moved.map((m) => [m.slug, m]));
    expect(bySlug.get('claude-x')?.movement).toEqual({ rankDelta: -1, isNew: false });
    expect(bySlug.get('gemini-y')?.movement).toEqual({ rankDelta: 2, isNew: false });
    expect(bySlug.get('o3-mini')?.movement).toEqual({ rankDelta: -1, isNew: false });
  });
  it('marks a model missing from the previous ranking as new', () => {
    const moved = applyMovement(models.slice(0, 2), ['claude-x', 'gemini-y'], ['gemini-y']);
    const bySlug = new Map(moved.map((m) => [m.slug, m]));
    expect(bySlug.get('claude-x')?.movement).toEqual({ rankDelta: 0, isNew: true });
  });
  it('keeps every movement null without a previous snapshot', () => {
    const moved = applyMovement(models, ['claude-x', 'gemini-y'], []);
    expect(moved.every((m) => m.movement === null)).toBe(true);
  });
});

describe('createLeaderboardSource', () => {
  it('serves fresh data, then answers from the 24 h cache without another provider call', async () => {
    const provider = providerJson(aaBody(DAY_ONE));
    let clock = 0;
    const source = createLeaderboardSource({ fetch: provider, now: () => clock, apiKey: 'k' });
    const first = await source.read();
    expect(first.status).toBe('ok');
    if (first.status === 'ok') {
      expect(first.rankings.overall[0]).toBe('claude-x');
      expect(first.provenance).toContain('Artificial Analysis');
    }
    await source.read();
    expect(provider).toHaveBeenCalledTimes(1);
    clock += LEADERBOARD_TTL_MS;
    await source.read();
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it('serves the last good snapshot with its ORIGINAL syncedAt when a later refresh fails', async () => {
    const day: unknown = aaBody(DAY_ONE);
    let failing = false;
    let clock = 0;
    const provider = vi.fn(async () => new Response(JSON.stringify(day), { status: failing ? 503 : 200 })) as unknown as typeof fetch;
    const source = createLeaderboardSource({ fetch: provider, now: () => clock, apiKey: 'k' });
    const first = await source.read();
    if (first.status !== 'ok') throw new Error('first read must succeed');
    failing = true;
    clock += LEADERBOARD_TTL_MS + 1;
    const second = await source.read();
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.syncedAt).toBe(first.syncedAt);
  });
  it('answers no-key honestly without calling the provider', async () => {
    const provider = providerJson(aaBody(DAY_ONE));
    const source = createLeaderboardSource({ fetch: provider, now: () => 0, apiKey: '' });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'no-key' });
    expect(provider).toHaveBeenCalledTimes(0);
  });
  it('maps an unauthorized key to no-key', async () => {
    const provider = vi.fn(async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    const source = createLeaderboardSource({ fetch: provider, now: () => 0, apiKey: 'bad' });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'no-key' });
  });
  it('maps a hanging provider to timeout', async () => {
    const hanging = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const source = createLeaderboardSource({ fetch: hanging, now: () => 0, apiKey: 'k', timeoutMs: 5 });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });
  it('refuses an oversized body unread', async () => {
    const provider = providerJson(aaBody(DAY_ONE.concat(DAY_ONE)));
    const source = createLeaderboardSource({ fetch: provider, now: () => 0, apiKey: 'k', maxBodyBytes: 50 });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'malformed' });
  });
  it('refuses a response whose every row lacks a headline score', async () => {
    const provider = providerJson(aaBody([{ slug: 'x', name: 'X', evaluations: {} }]));
    const source = createLeaderboardSource({ fetch: provider, now: () => 0, apiKey: 'k' });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'empty' });
  });
  it('diffs movement across two daily snapshots', async () => {
    let day: unknown[] = [CLAUDE_X, GEMINI_Y, O3_MINI];
    let clock = 0;
    const provider = vi.fn(async () => new Response(JSON.stringify(aaBody(day)), { status: 200 })) as unknown as typeof fetch;
    const source = createLeaderboardSource({ fetch: provider, now: () => clock, apiKey: 'k' });
    const first = await source.read();
    if (first.status !== 'ok') throw new Error('first read must succeed');
    expect(first.models.every((m) => m.movement === null)).toBe(true);
    day = [{ ...GEMINI_Y, evaluations: { artificial_analysis_intelligence_index: 99 } }, CLAUDE_X, O3_MINI];
    clock += LEADERBOARD_TTL_MS + 1;
    const second = await source.read();
    if (second.status !== 'ok') throw new Error('second read must succeed');
    const bySlug = new Map(second.models.map((m) => [m.slug, m]));
    expect(bySlug.get('gemini-y')?.movement).toEqual({ rankDelta: 1, isNew: false });
    expect(bySlug.get('claude-x')?.movement).toEqual({ rankDelta: -1, isNew: false });
  });
  it('builds the provider URL from a fixed host only', () => {
    expect(leaderboardUrl()).toBe('https://artificialanalysis.ai/api/v2/language/models/free');
  });
});
