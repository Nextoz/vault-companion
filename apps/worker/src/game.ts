// GET /api/game composition (GAM1-A2): flatten EXISTING reads into `GameRecord`s for the pure engine, plus Journey
// step milestones from the health export. Read-only; no request input, no new write target, no new third-party call.
import {
  characterConfig,
  computeCharacter,
  computeStepMilestones,
  StoreUnavailable,
  StoreUnknownOutcome,
  userDate,
  type GameRecord,
  type VaultStore,
} from '@vault-companion/domain';
import {
  effectiveRadarDecisions,
  type ApiError,
  type GameResponse,
  type HealthHistoryResponse,
  type HistoryResponse,
  type LearningResponse,
  type RadarResponse,
  type TrainingResponse,
} from '@vault-companion/contracts';

export interface GameDeps {
  readonly store: VaultStore;
  readonly readTraining: () => Promise<TrainingResponse | ApiError>;
  readonly readLearning: () => Promise<LearningResponse | ApiError>;
  readonly readHistory: () => Promise<HistoryResponse | ApiError>;
  readonly readRadar: () => Promise<RadarResponse | ApiError>;
  readonly readHealthHistory: () => Promise<HealthHistoryResponse | ApiError>;
  readonly now: () => Date;
  readonly timeZone: string;
}

const UNAVAILABLE: ApiError = { code: 'upstream-unavailable', message: 'reader unavailable', retryable: true };
const isError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;
/** One failing reader never rejects the batch: it becomes a named, unavailable source. */
const settle = <T>(read: () => Promise<T | ApiError>): Promise<T | ApiError> => read().catch(() => UNAVAILABLE);

/** A kept paper becomes a Library record only once the desktop applied it to a real `Research/Library/` path. */
function keptLibraryRecords(response: RadarResponse, timeZone: string): GameRecord[] {
  const state = effectiveRadarDecisions(response.decisions);
  const records: GameRecord[] = [];
  for (const paperId of state.kept) {
    const decisionId = state.keepDecisionByPaper.get(paperId);
    if (!decisionId) continue;
    const applied = response.applied[decisionId];
    if (!applied || applied.status !== 'applied' || applied.libraryPath === null) continue;
    records.push({ source: 'library', date: userDate(applied.at, timeZone), id: decisionId });
  }
  return records;
}

export function createGameService(deps: GameDeps) {
  return {
    async readGame(): Promise<GameResponse | ApiError> {
      try {
        const { commitSha } = await deps.store.head();
        const [training, learning, history, radar, health] = await Promise.all([
          settle(deps.readTraining),
          settle(deps.readLearning),
          settle(deps.readHistory),
          settle(deps.readRadar),
          settle(deps.readHealthHistory),
        ]);
        const unavailable: string[] = [];
        const records: GameRecord[] = [];

        if (isError(training)) unavailable.push('training');
        else if (training.status === 'refused') unavailable.push('training');
        else if (training.status === 'ok') for (const row of training.rows) records.push({
          source: 'training', date: row.date, type: row.type, duration: row.duration,
          time: row.time, distance: row.distance, weight: row.weight, split: row.split, note: row.note,
        });
        // `absent` contributes nothing and is never a failure.

        if (isError(learning)) unavailable.push('learning');
        else if (learning.status === 'refused') unavailable.push('learning');
        else if (learning.status === 'ok') for (const row of learning.rows) records.push({
          source: 'learning', date: row.date, kind: row.kind, minutes: row.minutes,
          score: row.score, detail: row.detail, topic: row.topic, note: row.note,
        });

        if (isError(radar)) unavailable.push('library');
        else records.push(...keptLibraryRecords(radar, deps.timeZone));

        if (isError(history)) unavailable.push('tasks');
        else for (const item of history.items) records.push({
          // ADR-0021 completions carry no due date, so overdueDays is 0 and never a guess: the `clean-slate` overdue
          // achievement stays unearned until a completion source carries real overdue data.
          source: 'task', date: item.doneDate, overdueDays: 0,
          id: `${item.source}:${item.locator.path}:${item.locator.lineIndex}`,
        });

        const stepMilestones = isError(health) || health.status !== 'ok'
          ? null
          : computeStepMilestones(health.days.map((day) => ({ date: day.date, steps: day.steps })), characterConfig);
        if (stepMilestones === null) unavailable.push('health');

        const now = deps.now();
        const character = computeCharacter(records, characterConfig, userDate(now, deps.timeZone));
        return {
          revision: commitSha,
          now: now.toISOString(),
          // Spreads turn the domain's readonly arrays into the wire schema's mutable shape.
          character: { ...character, professions: [...character.professions], achievements: [...character.achievements], feats: [...character.feats] },
          stepMilestones: stepMilestones === null ? null : { ...stepMilestones, earned: [...stepMilestones.earned] },
          unavailable,
        };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return UNAVAILABLE;
        throw e;
      }
    },
  };
}
