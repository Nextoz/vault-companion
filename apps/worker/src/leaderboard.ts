// AI model leaderboard source (LB1, ADR-0066): one Artificial Analysis free-tier read a day, ranked by the
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

import { parseStoredLeaderboard, type LeaderboardStorage, type LeaderboardSnapshot, type StoredLeaderboard } from './leaderboard-storage.ts';

const INDEX_KEYS = {
  overall: 'artificial_analysis_intelligence_index',
  coding: 'artificial_analysis_coding_index',
  agentic: 'artificial_analysis_agentic_index',
  math: 'artificial_analysis_math_index',
} as const;
const PROVENANCE = `${LEADERBOARD_PROVIDER} (Intelligence Index)`;

export const LEADERBOARD_BASE_URL = 'https://artificialanalysis.ai/api/v2';
export const leaderboardUrl = (page = 1): string => `${LEADERBOARD_BASE_URL}/language/models/free?page=${page}`;
/** Daily window; only the scheduled refresh fetches, with durable UTC calendar-day deduplication. */
export const LEADERBOARD_TTL_MS = 24 * 60 * 60 * 1000;
export const LEADERBOARD_TIMEOUT_MS = 10_000;
/** The free model list runs to a few hundred KB; anything far larger is not a list we can trust. */
export const LEADERBOARD_MAX_BODY_BYTES = 2 * 1024 * 1024;


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
    if (key.startsWith('artificial_analysis_')) continue; // profession/composite indices are not individual benchmark scores
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
  readonly apiKey: string;
  readonly storage?: LeaderboardStorage;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

class ProviderFailure extends Error {
  constructor(readonly reason: LeaderboardUnavailableReason) { super(reason); }
}
const MAX_PAGES = 10;
async function readBody(response: Response, remaining: number): Promise<string> {
  const size = Number(response.headers.get('content-length') ?? 0);
  if (size > remaining || !response.body) throw new ProviderFailure('malformed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > remaining) throw new ProviderFailure('malformed');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

async function fetchAll(deps: LeaderboardSourceDeps): Promise<{ models: LeaderboardModel[]; version: number | null }> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(new ProviderFailure('timeout')); }, deps.timeoutMs ?? LEADERBOARD_TIMEOUT_MS);
  });
  const collect = async () => {
    const unique = new Map<string, LeaderboardModel>();
    let remaining = deps.maxBodyBytes ?? LEADERBOARD_MAX_BODY_BYTES;
    let total = 1, version: number | null = null, pageSize = 0;
    for (let page = 1; page <= total; page++) {
      if (abort.signal.aborted) throw new ProviderFailure('timeout');
      const response = await deps.fetch(leaderboardUrl(page), { redirect: 'error', signal: abort.signal, headers: { Accept: 'application/json', 'x-api-key': deps.apiKey } });
      if (!response.ok) throw new ProviderFailure(response.status === 401 || response.status === 403 ? 'no-key' : 'provider-error');
      const text = await readBody(response, remaining);
      remaining -= new TextEncoder().encode(text).byteLength;
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new ProviderFailure('malformed'); }
      const parsed = parseAaBody(body);
      if (!parsed || !isRecord(body) || !isRecord(body.pagination)) throw new ProviderFailure('malformed');
      const paging = body.pagination;
      if (paging.page !== page || !Number.isInteger(paging.total_pages) || !Number.isInteger(paging.page_size)
        || typeof paging.total_pages !== 'number' || paging.total_pages < 1 || paging.total_pages > MAX_PAGES
        || typeof paging.page_size !== 'number' || paging.page_size < 1 || paging.page_size > 1000
        || paging.has_more !== (page < paging.total_pages) || !Array.isArray(body.data) || body.data.length > paging.page_size
        || (paging.has_more && body.data.length !== paging.page_size)) throw new ProviderFailure('malformed');
      if (page === 1) { total = paging.total_pages; pageSize = paging.page_size; version = parsed.intelligenceIndexVersion; }
      else if (total !== paging.total_pages || pageSize !== paging.page_size || version !== parsed.intelligenceIndexVersion) throw new ProviderFailure('malformed');
      for (const model of parsed.models) {
        const prior = unique.get(model.slug);
        if (prior && JSON.stringify(prior) !== JSON.stringify(model)) throw new ProviderFailure('malformed');
        unique.set(model.slug, model);
      }
    }
    if (unique.size === 0) throw new ProviderFailure('empty');
    return { models: [...unique.values()], version };
  };
  try { return await Promise.race([collect(), timeout]); }
  finally { clearTimeout(timer); abort.abort(); }
}

export function createLeaderboardSource(deps: LeaderboardSourceDeps) {
  let lastGood: StoredLeaderboard | null = null;
  let inflight: Promise<LeaderboardResponse> | null = null;
  const unavailable = (reason: LeaderboardUnavailableReason): LeaderboardResponse => ({
    status: 'unavailable', now: new Date(deps.now()).toISOString(), reason, note: LEADERBOARD_REASON_NOTES[reason],
  });
  const display = (value: LeaderboardSnapshot, note: string | null = null): LeaderboardResponse => ({ ...value, now: new Date(deps.now()).toISOString(), note });
  const fallback = (reason: LeaderboardUnavailableReason): LeaderboardResponse => lastGood
    ? display(lastGood.current, `Last successful snapshot. ${LEADERBOARD_REASON_NOTES[reason]}`) : unavailable(reason);
  const hydrate = async (): Promise<void> => {
    if (!deps.storage) throw new ProviderFailure('storage-unavailable');
    let raw: unknown;
    try { raw = await deps.storage.read(); } catch { throw new ProviderFailure('storage-unavailable'); }
    if (raw === null) return;
    const parsed = parseStoredLeaderboard(raw, deps.now());
    if (!parsed) throw new ProviderFailure('malformed');
    // KV is eventually consistent: do not regress a newer local snapshot.
    if (!lastGood || Date.parse(parsed.current.syncedAt) >= Date.parse(lastGood.current.syncedAt)) lastGood = parsed;
  };
  const update = async (): Promise<LeaderboardResponse> => {
    try {
      await hydrate();
      // Calendar-day gate avoids skipping a day when cron arrives a few seconds early.
      if (lastGood?.current.syncedAt.slice(0, 10) === new Date(deps.now()).toISOString().slice(0, 10)) return display(lastGood.current);
      if (!deps.apiKey) return fallback('no-key');
      const data = await fetchAll(deps);
      const build = buildLeaderboard(data.models);
      const previous = lastGood?.current ?? null;
      const compare = previous?.intelligenceIndexVersion === data.version ? previous.rankings.overall : [];
      const now = new Date(deps.now()).toISOString();
      const current: LeaderboardSnapshot = {
        status: 'ok', now, syncedAt: now, provenance: PROVENANCE, intelligenceIndexVersion: data.version, note: null,
        models: applyMovement(build.models, build.rankings.overall, compare), rankings: build.rankings,
      };
      const next: StoredLeaderboard = { version: 1, current, previous };
      try { await deps.storage!.write(next); } catch { return fallback('storage-unavailable'); }
      lastGood = next;
      return display(current);
    } catch (error) { return fallback(error instanceof ProviderFailure ? error.reason : 'provider-error'); }
  };
  return {
    /** Dashboard reads storage only. They never consume provider quota. */
    async read(): Promise<LeaderboardResponse> {
      try { await hydrate(); return lastGood ? display(lastGood.current) : unavailable('no-data'); }
      catch (error) { return fallback(error instanceof ProviderFailure ? error.reason : 'storage-unavailable'); }
    },
    /** Cron-only refresh. One atomic durable write after every page succeeds. */
    refresh(): Promise<LeaderboardResponse> {
      if (!inflight) inflight = update().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
