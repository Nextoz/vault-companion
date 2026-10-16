// AI model leaderboard source (LB1, ADR-0065): one Artificial Analysis free-tier read a day, ranked by the
// provider's published indices. Cron-warmed and TTL-guarded, so opening the Dashboard never triggers provider
// calls; the last good snapshot is served honestly stale (original syncedAt) when the provider fails. No vault
// writes, no invented numbers.
import {
  LEADERBOARD_MAX_MODELS,
  LEADERBOARD_PROVIDER,
  LEADERBOARD_REASON_NOTES,
  LEADERBOARD_TOP_N,
  type LeaderboardCategoryId,
  type LeaderboardModel,
  type LeaderboardResponse,
  type LeaderboardUnavailableReason,
} from '@vault-companion/contracts';

const INDEX_KEYS = {
  overall: 'artificial_analysis_intelligence_index',
  coding: 'artificial_analysis_coding_index',
  agentic: 'artificial_analysis_agentic_index',
  math: 'artificial_analysis_math_index',
} as const;
const PROVENANCE = `${LEADERBOARD_PROVIDER} (Intelligence Index)`;

export const LEADERBOARD_BASE_URL = 'https://artificialanalysis.ai/api/v2';
export const leaderboardUrl = (): string => `${LEADERBOARD_BASE_URL}/language/models/free`;
/** One sync per 24 h: the scheduled refresh keeps this warm; a cold isolate refetches at most once a day. */
export const LEADERBOARD_TTL_MS = 24 * 60 * 60 * 1000;
export const LEADERBOARD_TIMEOUT_MS = 10_000;
/** The free model list runs to a few hundred KB; anything far larger is not a list we can trust. */
export const LEADERBOARD_MAX_BODY_BYTES = 2 * 1024 * 1024;

class TimedOut extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** One provider row -> one model, tolerantly. Free-tier rows omit most specs; a row without a slug, a name or ANY
 *  headline score is dropped rather than guessed at. Values are the provider's, never coerced. */
export function parseAaModel(raw: unknown): LeaderboardModel | null {
  if (!isRecord(raw)) return null;
  const slug = str(raw.slug);
  const name = str(raw.name);
  if (slug === null || name === null) return null;
  const creator = isRecord(raw.model_creator) ? str(raw.model_creator.name) : null;
  const evals = isRecord(raw.evaluations) ? raw.evaluations : {};
  const scores = {
    overall: num(evals[INDEX_KEYS.overall]),
    coding: num(evals[INDEX_KEYS.coding]),
    agentic: num(evals[INDEX_KEYS.agentic]),
    math: num(evals[INDEX_KEYS.math]),
  };
  if (scores.overall === null && scores.coding === null && scores.agentic === null && scores.math === null) return null;
  const benchmarks: { key: string; value: number }[] = [];
  for (const [key, value] of Object.entries(evals)) {
    if (key === INDEX_KEYS.overall || key === INDEX_KEYS.coding || key === INDEX_KEYS.agentic || key === INDEX_KEYS.math) continue;
    const parsed = num(value);
    if (parsed !== null) benchmarks.push({ key, value: parsed });
  }
  const pricing = isRecord(raw.pricing) ? raw.pricing : {};
  const performance = isRecord(raw.performance) ? raw.performance : {};
  const licensing = isRecord(raw.licensing) ? raw.licensing : {};
  const modalityKeys = (side: 'input' | 'output'): string[] => {
    const modalities = isRecord(raw.modalities) ? raw.modalities : null;
    const sideSpec = modalities !== null && isRecord(modalities[side]) ? modalities[side] : null;
    return sideSpec === null ? [] : Object.entries(sideSpec).filter(([, value]) => value === true).map(([key]) => key);
  };
  return {
    slug,
    name,
    provider: creator,
    scores,
    benchmarks,
    pricingInputPer1M: num(pricing.price_1m_input_tokens),
    pricingOutputPer1M: num(pricing.price_1m_output_tokens),
    medianTokensPerSecond: num(performance.median_output_tokens_per_second),
    medianTimeToFirstTokenSeconds: num(performance.median_time_to_first_token_seconds),
    releaseDate: str(raw.release_date),
    contextWindowTokens: num(raw.context_window_tokens),
    openWeights: bool(licensing.is_open_weights),
    reasoningModel: bool(raw.reasoning_model),
    inputModalities: modalityKeys('input'),
    outputModalities: modalityKeys('output'),
    movement: null,
  };
}

/** The documented provider envelope: `{ tier, intelligence_index_version, data: [...] }`. Anything else is refused. */
export function parseAaBody(body: unknown): { models: LeaderboardModel[]; intelligenceIndexVersion: number | null } | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null;
  const models: LeaderboardModel[] = [];
  for (const row of body.data) {
    const model = parseAaModel(row);
    if (model !== null) models.push(model);
  }
  return { models, intelligenceIndexVersion: num(body.intelligence_index_version) };
}

export interface LeaderboardBuild {
  readonly rankings: Record<LeaderboardCategoryId, string[]>;
  readonly models: LeaderboardModel[];
}

const byCategory = (models: readonly LeaderboardModel[], key: 'overall' | 'coding' | 'agentic' | 'math'): LeaderboardModel[] =>
  models
    .filter((model) => model.scores[key] !== null)
    .sort((a, b) => (b.scores[key] ?? 0) - (a.scores[key] ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** Rank per category: models missing that score are excluded (a missing metric is never a zero); ties break by
 *  name so equal scores are stable across days. The payload is every category's top N (union, capped). */
export function buildLeaderboard(models: readonly LeaderboardModel[]): LeaderboardBuild {
  const rankings: Record<LeaderboardCategoryId, string[]> = {
    overall: byCategory(models, 'overall').slice(0, LEADERBOARD_TOP_N).map((m) => m.slug),
    coding: byCategory(models, 'coding').slice(0, LEADERBOARD_TOP_N).map((m) => m.slug),
    agentic: byCategory(models, 'agentic').slice(0, LEADERBOARD_TOP_N).map((m) => m.slug),
    math: byCategory(models, 'math').slice(0, LEADERBOARD_TOP_N).map((m) => m.slug),
  };
  const overallRank = new Map(rankings.overall.map((slug, index) => [slug, index + 1] as const));
  const bySlug = new Map(models.map((model) => [model.slug, model] as const));
  const union = [...new Set([...rankings.overall, ...rankings.coding, ...rankings.agentic, ...rankings.math])];
  const payload = union
    .map((slug) => bySlug.get(slug))
    .filter((model): model is LeaderboardModel => model !== undefined)
    .sort((a, b) => (overallRank.get(a.slug) ?? 999) - (overallRank.get(b.slug) ?? 999) || (a.name < b.name ? -1 : 1))
    .slice(0, LEADERBOARD_MAX_MODELS);
  return { rankings, models: payload };
}

/** Movement vs the previous daily snapshot: positive rankDelta = climbed; isNew = absent from the previous overall
 *  ranking. Without a previous snapshot there is nothing honest to diff, so every movement stays null. */
export function applyMovement(models: readonly LeaderboardModel[], currentOverall: readonly string[], previousOverall: readonly string[]): LeaderboardModel[] {
  if (previousOverall.length === 0) return models.map((model) => ({ ...model, movement: null }));
  const current = new Map(currentOverall.map((slug, index) => [slug, index + 1] as const));
  const previous = new Map(previousOverall.map((slug, index) => [slug, index + 1] as const));
  return models.map((model) => {
    const now = current.get(model.slug);
    if (now === undefined) return { ...model, movement: null };
    const was = previous.get(model.slug);
    if (was === undefined) return { ...model, movement: { rankDelta: 0, isNew: true } };
    return { ...model, movement: { rankDelta: was - now, isNew: false } };
  });
}

export interface LeaderboardSourceDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  /** Worker secret AA_API_KEY; empty means the leaderboard answers honestly `no-key` and never calls the provider. */
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

async function readProviderJson(fetchImpl: typeof fetch, apiKey: string, timeoutMs: number, maxBodyBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: LeaderboardUnavailableReason }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new TimedOut());
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(leaderboardUrl(), { signal: abort.signal, headers: { Accept: 'application/json', 'User-Agent': 'vault-companion', 'x-api-key': apiKey } }),
      timedOut,
    ]);
    if (!response.ok) return { ok: false, reason: response.status === 401 || response.status === 403 ? 'no-key' : 'provider-error' };
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBodyBytes) return { ok: false, reason: 'malformed' };
    const text = await Promise.race([response.text(), timedOut]);
    if (text.length > maxBodyBytes) return { ok: false, reason: 'malformed' };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof TimedOut || abort.signal.aborted ? 'timeout' : 'provider-error' };
  } finally {
    clearTimeout(timer);
  }
}

export function createLeaderboardSource(deps: LeaderboardSourceDeps) {
  const timeoutMs = deps.timeoutMs ?? LEADERBOARD_TIMEOUT_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? LEADERBOARD_MAX_BODY_BYTES;
  let cache: { at: number; response: LeaderboardResponse } | null = null;
  let previousOverall: string[] = [];
  let inflight: Promise<LeaderboardResponse> | null = null;

  const unavailable = (reason: LeaderboardUnavailableReason): LeaderboardResponse => ({
    status: 'unavailable',
    now: new Date(deps.now()).toISOString(),
    reason,
    note: LEADERBOARD_REASON_NOTES[reason],
  });

  const refresh = async (): Promise<LeaderboardResponse> => {
    if (deps.apiKey === '') return unavailable('no-key');
    const result = await readProviderJson(deps.fetch, deps.apiKey, timeoutMs, maxBodyBytes);
    if (!result.ok) return unavailable(result.reason);
    const parsed = parseAaBody(result.body);
    if (parsed === null) return unavailable('malformed');
    if (parsed.models.length === 0) return unavailable('empty');
    const build = buildLeaderboard(parsed.models);
    const models = applyMovement(build.models, build.rankings.overall, previousOverall);
    previousOverall = build.rankings.overall;
    const nowIso = new Date(deps.now()).toISOString();
    return {
      status: 'ok',
      now: nowIso,
      syncedAt: nowIso,
      provenance: PROVENANCE,
      intelligenceIndexVersion: parsed.intelligenceIndexVersion,
      note: null,
      models,
      rankings: build.rankings,
    };
  };

  return {
    /** Cached while fresh (24 h), one shared provider fetch otherwise. A failed refresh serves the last good
     *  snapshot with its ORIGINAL syncedAt — a date is never silently repainted as new. */
    async read(): Promise<LeaderboardResponse> {
      if (cache !== null && deps.now() - cache.at < LEADERBOARD_TTL_MS) return cache.response;
      if (inflight === null) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      const fresh = await inflight;
      if (fresh.status === 'ok') {
        cache = { at: Date.parse(fresh.syncedAt), response: fresh };
        return fresh;
      }
      return cache !== null ? cache.response : fresh;
    },
  };
}
