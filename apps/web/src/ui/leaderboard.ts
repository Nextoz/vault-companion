// LB1 pure presentation helpers: rows per category, honest labels for scores/movement/strength, and the stale
// window. No fetch, no React; mirrors ai-usage.ts.
import {
  LEADERBOARD_BENCHMARKS,
  LEADERBOARD_CATEGORY_IDS,
  LEADERBOARD_CATEGORY_INFO,
  LEADERBOARD_REASON_NOTES,
  type LeaderboardCategoryId,
  type LeaderboardModel,
  type LeaderboardMovement,
  type LeaderboardResponse,
} from '@vault-companion/contracts';

/** A little past the daily sync window the panel says so in words; the date is never silently repainted as fresh. */
export const LEADERBOARD_STALE_MS = 26 * 60 * 60 * 1000;

export interface LeaderboardRow {
  readonly rank: number;
  readonly model: LeaderboardModel;
  readonly score: number | null;
  readonly movement: string | null;
}

/** Categories that actually have a ranking right now (a provider day without e.g. math scores hides that tab). */
export function leaderboardCategories(response: LeaderboardResponse): LeaderboardCategoryId[] {
  if (response.status !== 'ok') return [];
  return LEADERBOARD_CATEGORY_IDS.filter((id) => response.rankings[id].length > 0);
}

export function leaderboardRows(response: LeaderboardResponse, category: LeaderboardCategoryId): LeaderboardRow[] {
  if (response.status !== 'ok') return [];
  const bySlug = new Map(response.models.map((model) => [model.slug, model] as const));
  return response.rankings[category]
    .map((slug, index): LeaderboardRow | null => {
      const model = bySlug.get(slug);
      if (model === undefined) return null; // a ranking entry without payload is skipped, never guessed
      return { rank: index + 1, model, score: model.scores[category], movement: movementLabel(model.movement) };
    })
    .filter((row): row is LeaderboardRow => row !== null);
}

/** Index scores are 0–100 with one decimal; a missing score is a dash, never a zero. */
export function formatScore(score: number | null): string {
  return score === null ? '—' : score.toFixed(1);
}

/** Benchmark values arrive mixed-scale (0–1 accuracies, elo points, raw points); shown close to how published. */
export function formatBenchmark(value: number): string {
  if (value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

export function movementLabel(movement: LeaderboardMovement | null): string | null {
  if (movement === null) return null;
  if (movement.isNew) return 'New';
  if (movement.rankDelta === 0) return null;
  return `${movement.rankDelta > 0 ? '↑' : '↓'} ${Math.abs(movement.rankDelta)}`;
}

/** The model's best of coding/agentic/math — a compact hint, not a claim about overall quality. */
export function strongestCapability(model: LeaderboardModel): string | null {
  const candidates: [LeaderboardCategoryId, number][] = [
    ['coding', model.scores.coding ?? -1],
    ['agentic', model.scores.agentic ?? -1],
    ['math', model.scores.math ?? -1],
  ];
  const best = candidates.filter(([, score]) => score >= 0).sort((a, b) => b[1] - a[1])[0];
  return best === undefined ? null : LEADERBOARD_CATEGORY_INFO[best[0]].label;
}

/** Bar length relative to the best score in view: a visual comparison, never a value of its own. */
export function barRatio(score: number | null, best: number): number {
  if (score === null || best <= 0) return 0;
  return Math.max(0.04, Math.min(1, score / best));
}

export function leaderboardFresh(response: LeaderboardResponse, nowMs: number): boolean {
  return response.status === 'ok' && nowMs - Date.parse(response.syncedAt) <= LEADERBOARD_STALE_MS;
}

export function leaderboardNote(response: LeaderboardResponse): string {
  return response.status === 'ok' ? (response.note ?? '') : LEADERBOARD_REASON_NOTES[response.reason];
}

export function benchmarkMeta(key: string): { label: string; explainer: string } {
  return LEADERBOARD_BENCHMARKS[key] ?? { label: key, explainer: 'A newer evaluation; no description is available yet.' };
}

/** Spec lines that exist for this model (free-tier rows omit most; absent specs stay absent). */
export function specRows(model: LeaderboardModel): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (model.provider !== null) rows.push({ label: 'Provider', value: model.provider });
  if (model.releaseDate !== null) rows.push({ label: 'Released', value: model.releaseDate });
  if (model.openWeights !== null) rows.push({ label: 'Weights', value: model.openWeights ? 'Open weights' : 'Proprietary' });
  if (model.contextWindowTokens !== null) rows.push({ label: 'Context window', value: `${new Intl.NumberFormat('en-US').format(model.contextWindowTokens)} tokens` });
  if (model.pricingInputPer1M !== null) rows.push({ label: 'Input price', value: `$${model.pricingInputPer1M} / M tokens` });
  if (model.pricingOutputPer1M !== null) rows.push({ label: 'Output price', value: `$${model.pricingOutputPer1M} / M tokens` });
  if (model.medianTokensPerSecond !== null) rows.push({ label: 'Speed', value: `${Math.round(model.medianTokensPerSecond)} tokens/s (median)` });
  if (model.reasoningModel !== null) rows.push({ label: 'Type', value: model.reasoningModel ? 'Reasoning model' : 'Non-reasoning' });
  if (model.inputModalities.length > 0) rows.push({ label: 'Inputs', value: model.inputModalities.join(', ') });
  if (model.outputModalities.length > 0) rows.push({ label: 'Outputs', value: model.outputModalities.join(', ') });
  return rows;
}
