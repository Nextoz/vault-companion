import type { AchievementResult, Character, CharacterConfig, Criterion, SourceRule } from './types.ts';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
function calendarDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp / DAY_MS : null;
}
// UTC is used only for arithmetic on date labels, never to reinterpret a local timestamp.
const isoWeek = (day: number): number => day - ((new Date(day * DAY_MS).getUTCDay() + WEEK_DAYS - 1) % WEEK_DAYS);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function minutes(value: unknown, format: 'minutes' | 'duration'): number {
  if (typeof value !== 'string') return 0;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?(?:\s*(?:m|min|minutes?))?$/.test(text)) {
    const parsed = Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (format === 'duration' && /^\d+:\d{2}(?::\d{2})?$/.test(text)) {
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some(part => part >= 60)) return 0;
    // mm:ss or hh:mm:ss; plain numbers and "30 min" mean minutes.
    const result = parts.length === 3 ? parts[0]! * 60 + parts[1]! + parts[2]! / 60 : parts[0]! + parts[1]! / 60;
    return Number.isFinite(result) ? result : 0;
  }
  return 0;
}
/** FNV-1a (32-bit): a stable, dependency-free hash. Not cryptographic; it only spreads criticals evenly. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}
/**
 * ADR-0064: whether the `ordinal`-th capped award of `source` on `date` is critical. Keyed by the day's ordinal, not the
 * record identity (task ids carry a line index that shifts), so a recompute never moves a past critical.
 */
export function isCritical(date: string, source: string, ordinal: number, every: number): boolean {
  return every > 0 && fnv1a(`${date}|${source}|${ordinal}`) % every === 0;
}
interface Row { date: string; day: number; source: string; identity: string; minutes: number; overdue: number; key: string; rule: SourceRule }
interface SourceState { count: number; varieties: Set<string>; minutes: number; overdue: number; week: number | null; consecutive: number; bestWeeks: number }
const initialSource = (): SourceState => ({ count: 0, varieties: new Set(), minutes: 0, overdue: 0, week: null, consecutive: 0, bestWeeks: 0 });

export function computeCharacter(records: readonly unknown[], config: CharacterConfig, today: string): Character {
  const endDay = calendarDay(today);
  if (endDay === null) throw new RangeError('today must be a calendar date (YYYY-MM-DD)');
  const rows: Row[] = [];
  let skippedRecords = 0;
  for (const input of records) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) { skippedRecords++; continue; }
    const record = input as Readonly<Record<string, unknown>>;
    const source = record['source'];
    const rule = typeof source === 'string' && Object.hasOwn(config.sources, source) ? config.sources[source] : undefined;
    const day = calendarDay(record['date']);
    const identity = rule ? record[rule.identityField] : undefined;
    const overdue = rule?.overdue ? record[rule.overdue.field] : 0;
    if (!rule || typeof source !== 'string' || day === null || day > endDay || typeof identity !== 'string' || !identity.trim() || typeof overdue !== 'number' || !Number.isFinite(overdue) || overdue < 0 || !Number.isInteger(overdue) || !config.professions.some(p => p.id === rule.profession)) {
      skippedRecords++; continue;
    }
    if (!rule.enabled) continue;
    const duration = rule.minutes ? minutes(record[rule.minutes.field], rule.minutes.format) : 0;
    // Only award-relevant fields participate: private text and excluded measurements never matter.
    rows.push({ date: record['date'] as string, day, source, identity, minutes: duration, overdue, key: JSON.stringify([source, identity, duration, overdue]), rule });
  }
  rows.sort((a, b) => a.day - b.day || compare(a.key, b.key));
  const xpByProfession = new Map(config.professions.map(p => [p.id, 0]));
  const skills = new Map(config.professions.map(p => [p.id, 0]));
  const skillRemainders = new Map(config.professions.map(p => [p.id, 0]));
  const sources = new Map<string, SourceState>();
  const earned = new Map<string, string>();
  const earnedBy = new Map<string, string>();
  let criticals = 0;
  const daily = new Map<string, { count: number; overdue: number }>();
  let xp = 0;
  let level: number = config.level.min;
  let levelXp = 0;
  const levelCost = (): number => level === config.level.max ? 0 : config.level.baseCost + config.level.costStep * (level - config.level.min);
  let reserve = 0;
  let restedEarned = 0;
  let currentDay = rows[0]?.day ?? endDay;
  let dayHasXp = false;
  let previousRecordDay = currentDay;
  let longestGap = 0;
  let currentWeek: number | null = null;
  const weekProfessions = new Set<string>();
  let balanced = 0;
  const earlyProfessions = new Set<string>();
  const firstDay = currentDay;
  const advance = (day: number): void => {
    if (day === currentDay) return;
    const idle = Math.max(0, day - currentDay - (dayHasXp ? 1 : 0));
    reserve = Math.min(config.rested.max, reserve + idle * config.rested.perDay);
    currentDay = day;
    dayHasXp = false;
    daily.clear();
  };
  const progress = (criterion: Criterion): number => {
    const state = 'source' in criterion ? sources.get(criterion.source) : undefined;
    switch (criterion.kind) {
      case 'xp': return xp;
      case 'level': return level;
      case 'rested': return restedEarned;
      case 'gap': return longestGap;
      case 'balanced': return balanced;
      case 'founding': return rows.length ? 1 : 0;
      case 'dayOne': return earlyProfessions.size;
      case 'skill': return skills.get(criterion.profession) ?? 0;
      case 'count': return state?.count ?? 0;
      case 'variety': return state?.varieties.size ?? 0;
      case 'minutes': return state?.minutes ?? 0;
      case 'overdue': return state?.overdue ?? 0;
      case 'weeks': return state?.bestWeeks ?? 0;
      case 'meta': return criterion.requires.filter(id => earned.has(id)).length;
    }
  };
  const target = (criterion: Criterion): number => criterion.kind === 'meta' ? criterion.requires.length : criterion.target;
  const evaluate = (date: string, source: string): void => {
    // Fixed point makes nested metas independent of catalogue ordering.
    let changed = true;
    while (changed) {
      changed = false;
      for (const achievement of config.achievements) {
        if (!achievement.locked && !earned.has(achievement.id) && progress(achievement.criterion) >= target(achievement.criterion)) {
          earned.set(achievement.id, date);
          earnedBy.set(achievement.id, source);
          changed = true;
        }
      }
    }
  };
  for (const row of rows) {
    advance(row.day);
    longestGap = Math.max(longestGap, row.day - previousRecordDay);
    previousRecordDay = row.day;
    const state = sources.get(row.source) ?? initialSource();
    sources.set(row.source, state);
    state.count++;
    state.varieties.add(row.identity);
    state.minutes = Math.max(state.minutes, row.minutes);
    state.overdue = Math.max(state.overdue, row.overdue);
    const week = isoWeek(row.day);
    if (state.week !== week) {
      state.consecutive = state.week !== null && week - state.week === WEEK_DAYS ? state.consecutive + 1 : 1;
      state.bestWeeks = Math.max(state.bestWeeks, state.consecutive);
      state.week = week;
    }
    const cap = daily.get(row.source) ?? { count: 0, overdue: 0 };
    daily.set(row.source, cap);
    let base = 0;
    if (cap.count < row.rule.dailyCap) {
      cap.count++;
      base = row.rule.baseXp;
      const bonus = row.rule.minutes;
      if (bonus) base += Math.min(bonus.maxBonus, Math.max(0, Math.floor((row.minutes - bonus.after) / bonus.step)) * bonus.xp);
      const overdue = row.rule.overdue;
      if (overdue && row.overdue >= overdue.days && cap.overdue < overdue.dailyCap) { base += overdue.xp; cap.overdue++; }
      if (base > 0 && isCritical(row.date, row.source, cap.count, config.critical.every)) { base *= config.critical.multiplier; criticals++; }
    }
    const rested = Math.min(reserve, base * config.rested.multiplier);
    reserve -= rested;
    restedEarned += rested;
    const award = base + rested;
    if (award > 0) {
      dayHasXp = true;
      xp += award;
      levelXp += award;
      while (level < config.level.max && levelXp >= levelCost()) { levelXp -= levelCost(); level++; }
      if (level === config.level.max) levelXp = 0;
      const profession = row.rule.profession;
      xpByProfession.set(profession, xpByProfession.get(profession)! + award);
      let skill = skills.get(profession)!;
      let remaining = skillRemainders.get(profession)! + award;
      const skillCost = (): number => config.skill.baseCost + Math.floor(skill / config.skill.step);
      while (skill < config.skill.max && remaining >= skillCost()) { remaining -= skillCost(); skill++; }
      skills.set(profession, skill);
      skillRemainders.set(profession, remaining);
      if (currentWeek !== week) { weekProfessions.clear(); currentWeek = week; }
      weekProfessions.add(profession);
      balanced = Math.max(balanced, weekProfessions.size);
      if (row.day - firstDay < config.dayOneDays) earlyProfessions.add(profession);
    }
    evaluate(row.date, row.source);
  }
  if (rows.length) advance(endDay);
  const results = config.achievements.map((a): AchievementResult => {
    const earnedDate = earned.get(a.id) ?? null;
    const visible = !a.chain || !config.achievements.some(prior => prior.chain === a.chain && prior.tier! < a.tier! && !earned.has(prior.id));
    return {
      id: a.id, name: a.type === 'hidden' && !earnedDate ? '???' : a.name, category: a.category, type: a.type, points: a.points,
      earned: earnedDate !== null, earnedDate, earnedBy: earnedBy.get(a.id) ?? null, visible, locked: a.locked ?? false, lockedReason: a.lockedReason ?? null, chain: a.chain ?? null, tier: a.tier ?? null,
      progress: a.criterion.kind === 'weeks' || a.type === 'hidden' || a.type === 'feat' ? null : { current: a.locked || !rows.length ? 0 : Math.min(target(a.criterion), progress(a.criterion)), target: target(a.criterion) },
    };
  });
  const byCategory: Record<string, number> = {};
  for (const a of results.filter(a => a.type !== 'feat')) byCategory[a.category] = (byCategory[a.category] ?? 0) + (a.earned ? a.points : 0);
  return {
    rulesVersion: config.rulesVersion, xp, level, levelXp, levelCost: levelCost(), restedXp: reserve, criticals,
    title: config.titles.filter(t => t.level <= level).at(-1)?.title ?? '',
    professions: config.professions.map(p => {
      const skill = skills.get(p.id)!;
      const rank = config.ranks.filter(r => r.skill <= skill).at(-1)!;
      return { ...p, xp: xpByProfession.get(p.id)!, skill, rank: rank.name, title: rank.title.replace('{profession}', p.name) };
    }),
    achievements: results.filter(a => a.type !== 'feat'), feats: results.filter(a => a.type === 'feat'),
    points: { total: Object.values(byCategory).reduce((sum, value) => sum + value, 0), byCategory }, skippedRecords,
  };
}
