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
interface Row { date: string; day: number; source: string; identity: string; minutes: number; overdue: number; key: string; rule: SourceRule; record: Readonly<Record<string, unknown>> }
interface Run { last: number | null; length: number; best: number; restDay: number | null }
interface SourceState {
  count: number; varieties: Set<string>; minutes: number; overdue: number;
  perDay: Map<number, number>; perWeek: Map<number, number>; perMonth: Map<number, number>; peak: { day: number; week: number; month: number };
  /** Keyed by the per-week minimum: the last qualifying week, the current and the best consecutive run. */
  weekRuns: Map<number, { last: number | null; consecutive: number; best: number }>;
  run: Run; restRun: Run; weekendMasks: Map<number, number>; weekends: number; distinct: Map<string, Set<string>>; months: Set<number>;
}
const newRun = (): Run => ({ last: null, length: 0, best: 0, restDay: null });
const initialSource = (): SourceState => ({
  count: 0, varieties: new Set(), minutes: 0, overdue: 0, perDay: new Map(), perWeek: new Map(), perMonth: new Map(), peak: { day: 0, week: 0, month: 0 },
  weekRuns: new Map(), run: newRun(), restRun: newRun(), weekendMasks: new Map(), weekends: 0, distinct: new Map(), months: new Set(),
});
const utc = (day: number): Date => new Date(day * DAY_MS);
const monthIndex = (day: number): number => utc(day).getUTCFullYear() * 12 + utc(day).getUTCMonth();
const bump = (counts: Map<number, number>, key: number): number => { const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return n; };
/** A day continues a run when it follows the last one; with `rest`, a single missed day is allowed once per 7 days. */
function extendRun(run: Run, day: number, rest: boolean): void {
  if (run.last === day) return;
  const gap = run.last === null ? Infinity : day - run.last;
  if (gap === 1) run.length++;
  else if (rest && gap === 2 && (run.restDay === null || day - 1 - run.restDay >= WEEK_DAYS)) { run.length++; run.restDay = day - 1; }
  else { run.length = 1; run.restDay = null; }
  run.last = day;
  run.best = Math.max(run.best, run.length);
}

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
    rows.push({ date: record['date'] as string, day, source, identity, minutes: duration, overdue, key: JSON.stringify([source, identity, duration, overdue]), rule, record });
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
  // Per-criterion inputs the catalogue asks for, collected once so the loop only tracks what is needed.
  const criteria = config.achievements.map(a => a.criterion);
  const weekMinimums = new Set(criteria.flatMap(c => c.kind === 'weeks' ? [c.perWeek ?? 1] : []));
  const distinctFields = new Set(criteria.flatMap(c => c.kind === 'distinct' ? [c.field] : []));
  const togetherKey = (sources: readonly string[]): string => JSON.stringify([...sources].sort());
  const togetherSets = new Map(criteria.flatMap(c => c.kind === 'together' ? [[togetherKey(c.sources), c.sources] as const] : []));
  const togetherDays = new Map<string, number>();
  let rowDay: number | null = null;
  const daySources = new Set<string>();
  const dayProfessions = new Set<string>();
  let bestDayProfessions = 0;
  let xpWeek: number | null = null;
  const xpWeekDays = new Set<number>();
  let fullWeeks = 0;
  let earnedPoints = 0;
  const pointsOf = new Map(config.achievements.map(a => [a.id, a.type === 'feat' ? 0 : a.points]));
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
      case 'weeks': return state?.weekRuns.get(criterion.perWeek ?? 1)?.best ?? 0;
      case 'run': return (criterion.rest ? state?.restRun.best : state?.run.best) ?? 0;
      case 'peak': return state?.peak[criterion.window] ?? 0;
      case 'weekends': return state?.weekends ?? 0;
      case 'distinct': return state?.distinct.get(criterion.field)?.size ?? 0;
      case 'months': return criterion.months.filter(m => state?.months.has(m)).length;
      case 'together': return togetherDays.get(togetherKey(criterion.sources)) ?? 0;
      case 'dayProfessions': return bestDayProfessions;
      case 'fullWeeks': return fullWeeks;
      case 'points': return earnedPoints;
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
          earnedPoints += pointsOf.get(achievement.id) ?? 0;
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
    if (rowDay !== row.day) { rowDay = row.day; daySources.clear(); dayProfessions.clear(); }
    state.peak.day = Math.max(state.peak.day, bump(state.perDay, row.day));
    const inWeek = bump(state.perWeek, week);
    state.peak.week = Math.max(state.peak.week, inWeek);
    state.peak.month = Math.max(state.peak.month, bump(state.perMonth, monthIndex(row.day)));
    // A week qualifies the moment it reaches the minimum; consecutive means exactly 7 days after the last one.
    for (const minimum of weekMinimums) {
      if (inWeek !== minimum) continue;
      const runState = state.weekRuns.get(minimum) ?? { last: null, consecutive: 0, best: 0 };
      runState.consecutive = runState.last !== null && week - runState.last === WEEK_DAYS ? runState.consecutive + 1 : 1;
      runState.best = Math.max(runState.best, runState.consecutive);
      runState.last = week;
      state.weekRuns.set(minimum, runState);
    }
    extendRun(state.run, row.day, false);
    extendRun(state.restRun, row.day, true);
    const weekday = row.day - week;
    if (weekday >= 5) {
      const before = state.weekendMasks.get(week) ?? 0;
      const after = before | (weekday === 5 ? 1 : 2);
      state.weekendMasks.set(week, after);
      if (before !== 3 && after === 3) state.weekends++;
    }
    for (const field of distinctFields) {
      const value = row.record[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const values = state.distinct.get(field) ?? new Set<string>();
      values.add(value.trim().toLowerCase());
      state.distinct.set(field, values);
    }
    state.months.add(utc(row.day).getUTCMonth() + 1);
    if (!daySources.has(row.source)) {
      daySources.add(row.source);
      for (const [key, sources] of togetherSets) {
        if (sources.includes(row.source) && sources.every(s => daySources.has(s))) togetherDays.set(key, (togetherDays.get(key) ?? 0) + 1);
      }
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
      dayProfessions.add(profession);
      bestDayProfessions = Math.max(bestDayProfessions, dayProfessions.size);
      if (xpWeek !== week) { xpWeekDays.clear(); xpWeek = week; }
      if (!xpWeekDays.has(row.day)) { xpWeekDays.add(row.day); if (xpWeekDays.size === WEEK_DAYS) fullWeeks++; }
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
      // Week rhythms show no counter (it would visibly reset); every other progress here is a best-ever value.
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
