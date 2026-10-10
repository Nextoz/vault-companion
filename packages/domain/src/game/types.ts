/** Adapters supply calendar dates, completed tasks and kept notes; no I/O occurs here. */
export type GameRecord =
  | { readonly source: 'training'; readonly date: string; readonly type: string; readonly duration: string; readonly time?: string; readonly distance?: string; readonly weight?: string; readonly split?: string; readonly note?: string }
  | { readonly source: 'learning'; readonly date: string; readonly kind: string; readonly minutes: string; readonly score?: string; readonly detail?: string; readonly topic?: string; readonly note?: string }
  | { readonly source: 'library' | 'reflection'; readonly date: string; readonly id: string }
  | { readonly source: 'task'; readonly date: string; readonly id: string; readonly overdueDays: number };

export interface SourceRule {
  readonly profession: string;
  readonly enabled: boolean;
  readonly identityField: string;
  readonly baseXp: number;
  readonly dailyCap: number;
  readonly minutes?: { readonly field: string; readonly format: 'minutes' | 'duration'; readonly after: number; readonly step: number; readonly xp: number; readonly maxBonus: number };
  readonly overdue?: { readonly field: string; readonly days: number; readonly xp: number; readonly dailyCap: number };
}
export type Criterion =
  | { readonly kind: 'xp' | 'level' | 'rested' | 'gap' | 'balanced' | 'founding' | 'dayOne'; readonly target: number }
  | { readonly kind: 'count' | 'variety' | 'minutes' | 'weeks' | 'overdue'; readonly source: string; readonly target: number }
  | { readonly kind: 'skill'; readonly profession: string; readonly target: number }
  | { readonly kind: 'meta'; readonly requires: readonly string[] };
export interface AchievementDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly type: 'one-off' | 'counter' | 'chain' | 'meta' | 'hidden' | 'feat';
  readonly points: number;
  readonly criterion: Criterion;
  readonly chain?: string;
  readonly tier?: number;
  readonly locked?: boolean;
  readonly lockedReason?: string;
}
export interface CharacterConfig {
  readonly rulesVersion: number;
  readonly professions: readonly { readonly id: string; readonly name: string }[];
  readonly sources: Readonly<Record<string, SourceRule>>;
  readonly skill: { readonly max: number; readonly baseCost: number; readonly step: number };
  readonly ranks: readonly { readonly skill: number; readonly name: string; readonly title: string }[];
  readonly level: { readonly min: number; readonly max: number; readonly baseCost: number; readonly costStep: number };
  readonly rested: { readonly perDay: number; readonly max: number; readonly multiplier: number };
  readonly titles: readonly { readonly level: number; readonly title: string }[];
  readonly dayOneDays: number;
  readonly achievements: readonly AchievementDefinition[];
}
export interface AchievementResult {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly type: AchievementDefinition['type'];
  readonly points: number;
  readonly earned: boolean;
  readonly earnedDate: string | null;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly chain: string | null;
  readonly tier: number | null;
  /** Weekly rhythm intentionally has no resetting counter. */
  readonly progress: { readonly current: number; readonly target: number } | null;
}
export interface Character {
  readonly rulesVersion: number;
  readonly xp: number;
  readonly level: number;
  readonly levelXp: number;
  /** Zero at maximum level. */
  readonly levelCost: number;
  readonly restedXp: number;
  readonly title: string;
  readonly professions: readonly { readonly id: string; readonly name: string; readonly xp: number; readonly skill: number; readonly rank: string; readonly title: string }[];
  readonly achievements: readonly AchievementResult[];
  readonly feats: readonly AchievementResult[];
  readonly points: { readonly total: number; readonly byCategory: Readonly<Record<string, number>> };
  readonly skippedRecords: number;
}
