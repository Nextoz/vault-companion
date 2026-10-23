/** Adapters supply calendar dates, completed tasks and kept notes; no I/O occurs here. */
export type GameRecord =
  | { readonly source: 'training'; readonly date: string; readonly type: string; readonly duration: string; readonly time?: string; readonly distance?: string; readonly weight?: string; readonly split?: string; readonly note?: string }
  | { readonly source: 'learning'; readonly date: string; readonly kind: string; readonly minutes: string; readonly score?: string; readonly detail?: string; readonly topic?: string; readonly note?: string }
  | { readonly source: 'library' | 'reflection' | 'quest'; readonly date: string; readonly id: string }
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
  | { readonly kind: 'count' | 'variety' | 'minutes' | 'overdue' | 'weekends'; readonly source: string; readonly target: number }
  /** Consecutive ISO weeks with at least `perWeek` (default 1) records of the source. */
  | { readonly kind: 'weeks'; readonly source: string; readonly target: number; readonly perWeek?: number }
  /** Best run of consecutive days with the source; `rest` lets one missed day per 7 keep the run alive. */
  | { readonly kind: 'run'; readonly source: string; readonly target: number; readonly rest?: boolean }
  /** Most records of the source in one calendar day, ISO week or calendar month. */
  | { readonly kind: 'peak'; readonly source: string; readonly window: 'day' | 'week' | 'month'; readonly target: number }
  /** Distinct non-empty values of a record field (case-insensitive), e.g. learning topics. */
  | { readonly kind: 'distinct'; readonly source: string; readonly field: string; readonly target: number }
  /** How many of the listed calendar months (1-12, any year) have a record of the source. */
  | { readonly kind: 'months'; readonly source: string; readonly months: readonly number[]; readonly target: number }
  /** Days on which every listed source has a record. */
  | { readonly kind: 'together'; readonly sources: readonly string[]; readonly target: number }
  /** dayProfessions: most professions with XP in one day; fullWeeks: ISO weeks with XP on all 7 days; points: achievement points. */
  | { readonly kind: 'dayProfessions' | 'fullWeeks' | 'points'; readonly target: number }
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
  /** Step-milestone thresholds and points; steps never award XP (owner decision 10 Oct 2026). */
  readonly steps: StepMilestoneRules;
  readonly skill: { readonly max: number; readonly baseCost: number; readonly step: number };
  readonly ranks: readonly { readonly skill: number; readonly name: string; readonly title: string }[];
  readonly level: { readonly min: number; readonly max: number; readonly baseCost: number; readonly costStep: number };
  readonly rested: { readonly perDay: number; readonly max: number; readonly multiplier: number };
  /** A deterministic surprise: about one award in `every` has its base XP multiplied (ADR-0064). */
  readonly critical: { readonly every: number; readonly multiplier: number };
  readonly titles: readonly { readonly level: number; readonly title: string }[];
  readonly dayOneDays: number;
  readonly achievements: readonly AchievementDefinition[];
}

/** Journey milestone data. Thresholds are cumulative step totals; each calendar year is counted separately. */
export interface StepMilestoneRules {
  readonly lifetime: readonly number[];
  /** Recurring lifetime threshold every this many steps past the last explicit one. */
  readonly lifetimeEvery: number;
  readonly yearly: readonly number[];
  /** One point value per threshold, plus the value for every recurring lifetime milestone. */
  readonly points: { readonly lifetime: readonly number[]; readonly recurring: number; readonly yearly: readonly number[] };
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
  /** The source of the record whose award earned it (`task`, `training`, ...); null when unearned. */
  readonly earnedBy: string | null;
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
  /** How many awards so far were critical (ADR-0064); the phone diffs it to announce a new one. */
  readonly criticals: number;
  readonly title: string;
  readonly professions: readonly { readonly id: string; readonly name: string; readonly xp: number; readonly skill: number; readonly rank: string; readonly title: string }[];
  readonly achievements: readonly AchievementResult[];
  readonly feats: readonly AchievementResult[];
  readonly points: { readonly total: number; readonly byCategory: Readonly<Record<string, number>> };
  readonly skippedRecords: number;
}
