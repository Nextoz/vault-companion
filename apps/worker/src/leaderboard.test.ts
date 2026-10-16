// LB1 tests. Fixtures follow the provider's documented response shape (their published examples: the o3-mini list
// row and the gpt-oss-20b detail row); extra rows exist only to make ties, nulls and movement testable.
import { describe, expect, it, vi } from 'vitest';
import { createLeaderboardStorage, parseStoredLeaderboard, LEADERBOARD_STORAGE_KEY, type StoredLeaderboard } from './leaderboard-storage.ts';
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
const aaBody = (data: unknown[], version = 4.3, paging: Record<string, unknown> = {}): unknown => ({ tier: 'free', intelligence_index_version: version, data, pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false, ...paging } });
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

function memoryStorage() {
  let value: unknown = null;
  return {
    storage: { read: vi.fn(async () => structuredClone(value)), write: vi.fn(async (next: StoredLeaderboard) => { value = structuredClone(next); }) },
    peek: () => value as StoredLeaderboard,
    seed: (raw: unknown) => { value = raw; },
  };
}
describe('durable leaderboard source', () => {
  it('reads storage without ever fetching and refreshes at most once per UTC day', async () => {
    const mem = memoryStorage(), provider = providerJson(aaBody(DAY_ONE)); let clock = Date.parse('2026-10-15T04:30:05Z');
    const source = createLeaderboardSource({ storage: mem.storage, fetch: provider, now: () => clock, apiKey: 'synthetic' });
    expect(await source.read()).toMatchObject({ status: 'unavailable', reason: 'no-data' }); expect(provider).not.toHaveBeenCalled();
    await source.refresh(); await source.read(); await source.refresh(); expect(provider).toHaveBeenCalledTimes(1);
    // Next day's slightly earlier cron must not be skipped by a strict 24h TTL.
    clock += LEADERBOARD_TTL_MS - 5000; await source.refresh(); expect(provider).toHaveBeenCalledTimes(2);
  });
  it('collects all pages, deduplicates and commits exactly once', async () => {
    const mem = memoryStorage();
    const provider = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url).endsWith('page=1')
      ? aaBody([CLAUDE_X, GEMINI_Y], 4.3, { page_size: 2, total_pages: 2, has_more: true })
      : aaBody([GEMINI_Y, O3_MINI], 4.3, { page: 2, page_size: 2, total_pages: 2 })))) as unknown as typeof fetch;
    const source = createLeaderboardSource({ storage: mem.storage, fetch: provider, now: () => 0, apiKey: 'synthetic' });
    const result = await source.refresh(); expect(result.status).toBe('ok');
    expect(provider).toHaveBeenCalledTimes(2); expect(mem.storage.write).toHaveBeenCalledTimes(1);
    expect(mem.peek().current.models).toHaveLength(3);
    expect(String(vi.mocked(provider).mock.calls[0]?.[0])).toBe('https://artificialanalysis.ai/api/v2/language/models/free?page=1');
    expect(String(vi.mocked(provider).mock.calls[1]?.[0])).toContain('page=2');
  });
  it('preserves snapshot and history if a later page fails', async () => {
    const mem = memoryStorage(); let clock = 0;
    const source = createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE)), now: () => clock, apiKey: 'synthetic' });
    await source.refresh(); const before = structuredClone(mem.peek()); clock += LEADERBOARD_TTL_MS;
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(aaBody([CLAUDE_X], 4.3, { page_size: 1, total_pages: 2, has_more: true })))).mockResolvedValueOnce(new Response('', { status: 503 }));
    const restarted = createLeaderboardSource({ storage: mem.storage, fetch: fetcher, now: () => clock, apiKey: 'synthetic' });
    const result = await restarted.refresh(); expect(result).toMatchObject({ status: 'ok', syncedAt: before.current.syncedAt });
    expect(mem.peek()).toEqual(before); expect(mem.storage.write).toHaveBeenCalledTimes(1);
  });
  it('restores history across instances and diffs changed scores, not provider row order', async () => {
    const mem = memoryStorage();
    await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody([CLAUDE_X, GEMINI_Y])), now: () => 0, apiKey: 'synthetic' }).refresh();
    const changed = { ...GEMINI_Y, evaluations: { artificial_analysis_intelligence_index: 99 } };
    const second = createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody([CLAUDE_X, changed])), now: () => LEADERBOARD_TTL_MS, apiKey: 'synthetic' });
    const result = await second.refresh(); if (result.status !== 'ok') throw Error('expected success');
    expect(result.models.find(m => m.slug === 'gemini-y')?.movement?.rankDelta).toBe(1);
    expect(mem.peek().previous?.rankings.overall).toEqual(['claude-x', 'gemini-y']);
    const noFetch = vi.fn(); const third = createLeaderboardSource({ storage: mem.storage, fetch: noFetch, now: () => LEADERBOARD_TTL_MS + 100, apiKey: '' });
    expect(await third.read()).toMatchObject({ status: 'ok', syncedAt: result.syncedAt }); expect(noFetch).not.toHaveBeenCalled();
  });
  it('does not compare rankings across index versions', async () => {
    const mem = memoryStorage();
    await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE)), now: () => 0, apiKey: 'synthetic' }).refresh();
    const out = await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE, 5)), now: () => LEADERBOARD_TTL_MS, apiKey: 'synthetic' }).refresh();
    if (out.status !== 'ok') throw Error('expected success'); expect(out.models.every(m => m.movement === null)).toBe(true);
  });
  it('never reports fresh data if the durable write failed', async () => {
    const mem = memoryStorage(); mem.storage.write.mockRejectedValue(new Error('synthetic outage'));
    const source = createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE)), now: () => 0, apiKey: 'synthetic' });
    expect(await source.refresh()).toMatchObject({ status: 'unavailable', reason: 'storage-unavailable' }); expect(mem.peek()).toBeNull();
  });
  it('does not overwrite unreadable or malformed persisted history', async () => {
    const mem = memoryStorage(), provider = providerJson(aaBody(DAY_ONE)); mem.seed({ version: 1, current: {} });
    const source = createLeaderboardSource({ storage: mem.storage, fetch: provider, now: () => 0, apiKey: 'synthetic' });
    expect(await source.refresh()).toMatchObject({ reason: 'malformed' }); expect(provider).not.toHaveBeenCalled();
    mem.storage.read.mockRejectedValueOnce(new Error('synthetic outage')); expect(await source.read()).toMatchObject({ reason: 'storage-unavailable' });
  });
  it('single-flights overlapping refreshes', async () => {
    const mem = memoryStorage(), provider = providerJson(aaBody(DAY_ONE));
    const source = createLeaderboardSource({ storage: mem.storage, fetch: provider, now: () => 0, apiKey: 'synthetic' });
    await Promise.all([source.refresh(), source.refresh(), source.refresh()]); expect(provider).toHaveBeenCalledTimes(1); expect(mem.storage.write).toHaveBeenCalledTimes(1);
  });
  it('missing storage or API key never triggers provider calls', async () => {
    const provider = vi.fn(), mem = memoryStorage();
    expect(await createLeaderboardSource({ fetch: provider, now: () => 0, apiKey: 'synthetic' }).refresh()).toMatchObject({ reason: 'storage-unavailable' });
    expect(await createLeaderboardSource({ storage: mem.storage, fetch: provider, now: () => 0, apiKey: '' }).refresh()).toMatchObject({ reason: 'no-key' });
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    { data: [], pagination: { page: 1, page_size: 200, total_pages: 11, has_more: true } },
    { data: [CLAUDE_X], pagination: { page: 2, page_size: 200, total_pages: 1, has_more: false } },
    { data: [CLAUDE_X], pagination: { page: 1, page_size: 200, total_pages: 2, has_more: false } },
    { data: [CLAUDE_X] },
  ])('rejects malformed or unbounded pagination', async body => {
    const mem = memoryStorage(); const result = await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(body), now: () => 0, apiKey: 'synthetic' }).refresh();
    expect(result).toMatchObject({ reason: 'malformed' }); expect(mem.storage.write).not.toHaveBeenCalled();
  });
  it('bounds total response bytes and timeout', async () => {
    const mem = memoryStorage();
    expect(await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE)), maxBodyBytes: 20, now: () => 0, apiKey: 'synthetic' }).refresh()).toMatchObject({ reason: 'malformed' });
    const never = vi.fn(() => new Promise<Response>(() => {}));
    expect(await createLeaderboardSource({ storage: mem.storage, fetch: never, timeoutMs: 2, now: () => 0, apiKey: 'synthetic' }).refresh()).toMatchObject({ reason: 'timeout' });
  });
  it('empty data is unavailable rather than replacing last-good with an empty ranking', async () => {
    const mem = memoryStorage(); expect(await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody([])), now: () => 0, apiKey: 'synthetic' }).refresh()).toMatchObject({ reason: 'empty' });
  });
  it('retains every category top ten in the payload', () => {
    const rows = ['overall','coding','agentic','math'].flatMap((key, group) => Array.from({ length: 10 }, (_, i) => parseAaModel(aaRow(`test-${group}-${i}`, `Test ${group} ${i}`, 'Synthetic', { [({overall:'artificial_analysis_intelligence_index',coding:'artificial_analysis_coding_index',agentic:'artificial_analysis_agentic_index',math:'artificial_analysis_math_index'} as Record<string,string>)[key]!]: 100-i }))!));
    const built = buildLeaderboard(rows); expect(built.models).toHaveLength(40);
    expect(Object.values(built.rankings).flat().every(slug => built.models.some(m => m.slug === slug))).toBe(true);
  });
  it('uses fixed provider URLs', () => { expect(leaderboardUrl()).toBe('https://artificialanalysis.ai/api/v2/language/models/free?page=1'); });
});

describe('KV adapter and hydration', () => {
  it('writes current and previous together and reads JSON under one fixed key', async () => {
    const mem = memoryStorage(); await createLeaderboardSource({ storage: mem.storage, fetch: providerJson(aaBody(DAY_ONE)), now: () => 0, apiKey: 'synthetic' }).refresh();
    const get = vi.fn(async () => mem.peek()), put = vi.fn(async () => {}), adapter = createLeaderboardStorage({ get, put });
    await adapter.write(mem.peek()); expect(put).toHaveBeenCalledWith(LEADERBOARD_STORAGE_KEY, JSON.stringify(mem.peek()));
    await adapter.read(); expect(get).toHaveBeenCalledWith(LEADERBOARD_STORAGE_KEY, 'json');
    expect(parseStoredLeaderboard(mem.peek(),0)?.current.status).toBe('ok');
    const invalid = structuredClone(mem.peek()); invalid.current.rankings.overall.push('missing-payload'); expect(parseStoredLeaderboard(invalid,0)).toBeNull();
  });
});
