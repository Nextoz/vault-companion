// ADR-0067: the Character as it travels to the phone. Shared by the Worker (`GET /api/game`) and the phone's local
// prediction, so both produce byte-identical payloads from the same records.
import type { GameAchievement, GameCharacter, GameFeedback, GameRecordWire } from '@vault-companion/contracts';
import { describeAchievement, earnedByPhrase } from './describe.ts';
import type { AchievementResult, Character, CharacterConfig, GameRecord } from './types.ts';

/** The wire Character: exactly the GAM1 fields. ADR-0064 additions travel in `feedback`, never here (strict schema). */
function wireAchievement(a: AchievementResult): GameAchievement {
  return {
    id: a.id, name: a.name, category: a.category, type: a.type, points: a.points, earned: a.earned, earnedDate: a.earnedDate,
    visible: a.visible, locked: a.locked, lockedReason: a.lockedReason, chain: a.chain, tier: a.tier, progress: a.progress,
  };
}

export function wireCharacter(c: Character): GameCharacter {
  return {
    rulesVersion: c.rulesVersion, xp: c.xp, level: c.level, levelXp: c.levelXp, levelCost: c.levelCost, restedXp: c.restedXp,
    title: c.title, professions: [...c.professions], achievements: c.achievements.map(wireAchievement), feats: c.feats.map(wireAchievement),
    points: c.points, skippedRecords: c.skippedRecords,
  };
}

/** ADR-0064: descriptions and "earned by" lines. A hidden achievement says nothing until it is earned. */
export function gameFeedback(c: Character, config: CharacterConfig): GameFeedback {
  const achievements: GameFeedback['achievements'] = {};
  for (const a of [...c.achievements, ...c.feats]) {
    const definition = config.achievements.find((d) => d.id === a.id);
    if (!definition || (a.type === 'hidden' && !a.earned)) continue;
    achievements[a.id] = { description: describeAchievement(definition, config), earnedBy: earnedByPhrase(a.earnedBy) };
  }
  return { criticals: c.criticals, critical: { every: config.critical.every, multiplier: config.critical.multiplier }, achievements };
}

/**
 * Only the fields the engine reads (date, identity, minutes, topic, overdue days): private notes, scores and
 * measurements never leave the Worker in this list. The Worker computes from these same slim records, so the phone
 * adding one record to them reproduces the Worker's next answer exactly.
 */
export function slimRecord(record: GameRecord): GameRecordWire {
  switch (record.source) {
    case 'training': return { source: record.source, date: record.date, type: record.type, duration: record.duration };
    case 'learning': return { source: record.source, date: record.date, kind: record.kind, minutes: record.minutes, ...(record.topic ? { topic: record.topic } : {}) };
    case 'task': return { source: record.source, date: record.date, id: record.id, overdueDays: record.overdueDays };
    default: return { source: record.source, date: record.date, id: record.id };
  }
}
