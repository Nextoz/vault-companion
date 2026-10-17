// GET /api/game composition (GAM1-A2): flatten EXISTING reads into `GameRecord`s for the pure engine, plus Journey
// step milestones from the health export. Read-only; no request input, no new write target, no new third-party call.
import {
  characterConfig,
  computeCharacter,
  computeStepMilestones,
  describeAchievement,
  earnedByPhrase,
  readOnlyAt,
  StoreUnavailable,
  StoreUnknownOutcome,
  userDate,
  type AchievementResult,
  type Character,
  type GameRecord,
  type VaultStore,
} from '@vault-companion/domain';
import {
  effectiveRadarDecisions,
  type ApiError,
  type BooksResponse,
  type GameAchievement,
  type GameCharacter,
  type GameFeedback,
  type GameResponse,
  type GameRules,
  type HealthHistoryResponse,
  type HistoryResponse,
  type LearningResponse,
  type RadarResponse,
  type TrainingResponse,
} from '@vault-companion/contracts';

/**
 * Each reader gets a read-only view pinned to the commit this request resolved, so the whole projection costs one
 * `head` lookup and every source reads the same revision.
 */
export interface GameDeps {
  readonly store: VaultStore;
  readonly readTraining: (at: VaultStore) => Promise<TrainingResponse | ApiError>;
  readonly readLearning: (at: VaultStore) => Promise<LearningResponse | ApiError>;
  readonly readBooks: (at: VaultStore) => Promise<BooksResponse | ApiError>;
  readonly readHistory: (at: VaultStore) => Promise<HistoryResponse | ApiError>;
  readonly readRadar: (at: VaultStore) => Promise<RadarResponse | ApiError>;
  readonly readHealthHistory: (at: VaultStore) => Promise<HealthHistoryResponse | ApiError>;
  readonly now: () => Date;
  readonly timeZone: string;
}

const UNAVAILABLE: ApiError = { code: 'upstream-unavailable', message: 'reader unavailable', retryable: true };
const isError = (value: unknown): value is ApiError =>
  typeof value === 'object' && value !== null && 'code' in value && 'retryable' in value;
/** One failing reader never rejects the batch: it becomes a named, unavailable source. */
const settle = <T>(read: (at: VaultStore) => Promise<T | ApiError>, at: VaultStore): Promise<T | ApiError> =>
  read(at).catch(() => UNAVAILABLE);

/** The wire Character: exactly the GAM1 fields. ADR-0064 additions travel in `feedback`, never here (strict schema). */
function wireAchievement(a: AchievementResult): GameAchievement {
  return {
    id: a.id, name: a.name, category: a.category, type: a.type, points: a.points, earned: a.earned, earnedDate: a.earnedDate,
    visible: a.visible, locked: a.locked, lockedReason: a.lockedReason, chain: a.chain, tier: a.tier, progress: a.progress,
  };
}

function wireCharacter(c: Character): GameCharacter {
  return {
    rulesVersion: c.rulesVersion, xp: c.xp, level: c.level, levelXp: c.levelXp, levelCost: c.levelCost, restedXp: c.restedXp,
    title: c.title, professions: [...c.professions], achievements: c.achievements.map(wireAchievement), feats: c.feats.map(wireAchievement),
    points: c.points, skippedRecords: c.skippedRecords,
  };
}

/** ADR-0064: descriptions and "earned by" lines. A hidden achievement says nothing until it is earned. */
function gameFeedback(c: Character): GameFeedback {
  const achievements: GameFeedback['achievements'] = {};
  for (const a of [...c.achievements, ...c.feats]) {
    const definition = characterConfig.achievements.find((d) => d.id === a.id);
    if (!definition || (a.type === 'hidden' && !a.earned)) continue;
    achievements[a.id] = { description: describeAchievement(definition, characterConfig), earnedBy: earnedByPhrase(a.earnedBy) };
  }
  return { criticals: c.criticals, critical: { every: characterConfig.critical.every, multiplier: characterConfig.critical.multiplier }, achievements };
}

/** The live rules, projected from the single `characterConfig` so the web "How XP works" page cannot drift. */
function gameRules(): GameRules {
  return {
    rulesVersion: characterConfig.rulesVersion,
    professions: characterConfig.professions.map((p) => ({ id: p.id, name: p.name })),
    sources: Object.entries(characterConfig.sources).map(([id, s]) => ({
      id,
      profession: s.profession,
      enabled: s.enabled,
      baseXp: s.baseXp,
      dailyCap: s.dailyCap,
      minutes: s.minutes ? { after: s.minutes.after, step: s.minutes.step, xp: s.minutes.xp, maxBonus: s.minutes.maxBonus } : null,
      overdue: s.overdue ? { days: s.overdue.days, xp: s.overdue.xp, dailyCap: s.overdue.dailyCap } : null,
    })),
    skill: { max: characterConfig.skill.max, baseCost: characterConfig.skill.baseCost, step: characterConfig.skill.step },
    ranks: characterConfig.ranks.map((r) => ({ skill: r.skill, name: r.name, title: r.title })),
    level: { min: characterConfig.level.min, max: characterConfig.level.max, baseCost: characterConfig.level.baseCost, costStep: characterConfig.level.costStep },
    rested: { perDay: characterConfig.rested.perDay, max: characterConfig.rested.max, multiplier: characterConfig.rested.multiplier },
    titles: characterConfig.titles.map((t) => ({ level: t.level, title: t.title })),
  };
}

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
        const at = readOnlyAt(deps.store, commitSha);
        const [training, learning, books, history, radar, health] = await Promise.all([
          settle(deps.readTraining, at),
          settle(deps.readLearning, at),
          settle(deps.readBooks, at),
          settle(deps.readHistory, at),
          settle(deps.readRadar, at),
          settle(deps.readHealthHistory, at),
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

        if (isError(books)) unavailable.push('reflections');
        else if (books.status === 'refused') unavailable.push('reflections');
        else if (books.status === 'ok') for (const book of books.books) {
          const seen = new Map<string, number>();
          for (const reflection of book.reflections) {
            const n = seen.get(reflection.date) ?? 0;
            seen.set(reflection.date, n + 1);
            // Only the synthetic id leaves here: reflection text is private vault text and is never logged or sent.
            records.push({ source: 'reflection', date: reflection.date, id: JSON.stringify([book.title, reflection.date, n]) });
          }
        }

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
          rules: gameRules(),
          // Spreads turn the domain's readonly arrays into the wire schema's mutable shape.
          character: wireCharacter(character),
          stepMilestones: stepMilestones === null ? null : { ...stepMilestones, earned: [...stepMilestones.earned] },
          unavailable,
          feedback: gameFeedback(character),
        };
      } catch (e) {
        if (e instanceof StoreUnavailable || e instanceof StoreUnknownOutcome) return UNAVAILABLE;
        throw e;
      }
    },
  };
}
