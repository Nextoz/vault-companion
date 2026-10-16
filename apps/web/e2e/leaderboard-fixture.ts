import type { LeaderboardModel, LeaderboardResponse } from '@vault-companion/contracts';

const models: LeaderboardModel[] = Array.from({ length: 11 }, (_, i) => ({
  slug: `model-${i}`, name: `Synthetic Model ${String(i).padStart(2,'0')}`, provider: 'Synthetic Labs',
  scores: { overall: 90-i, coding: 50+i, agentic: null, math: null }, benchmarks: [],
  pricingInputPer1M: null, pricingOutputPer1M: null, medianTokensPerSecond: null, medianTimeToFirstTokenSeconds: null,
  releaseDate: null, contextWindowTokens: null, openWeights: null, reasoningModel: null, inputModalities: [], outputModalities: [],
  movement: i === 0 ? { rankDelta: 1, isNew: false } : null,
}));
export const leaderboardFixture = (syncedAt = new Date().toISOString()): LeaderboardResponse => ({
  status: 'ok', now: new Date().toISOString(), syncedAt, provenance: 'Artificial Analysis (Intelligence Index)', intelligenceIndexVersion: 4.3, note: null,
  models, rankings: { overall: models.map(m => m.slug), coding: [...models].reverse().map(m => m.slug), agentic: [], math: [] },
});
