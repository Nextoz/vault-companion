import { describe, expect, it } from 'vitest';
import { computeCharacter, isCritical } from './engine.ts';
import { characterConfig } from './config.ts';
import { earnedByPhrase } from './describe.ts';
import type { Character, CharacterConfig, GameRecord } from './types.ts';

// Arithmetic tests run with criticals off (ADR-0064); the 'critical awards' block covers them with the real config.
const config: CharacterConfig = { ...characterConfig, critical: { ...characterConfig.critical, every: 0 } };
const training = (date = '2026-01-01', type = 'Run', duration = '20'): GameRecord => ({ source: 'training', date, type, duration, time: '10:00', distance: '', weight: '', split: '', note: 'Synthetic' });
const learning = (date = '2026-01-01', minutes = '20'): GameRecord => ({ source: 'learning', date, kind: 'Reading', minutes, score: '0', detail: '', topic: '', note: '' });
const task = (id: string, overdueDays = 7, date = '2026-01-01'): GameRecord => ({ source: 'task', date, id, overdueDays });
const date = (offset: number): string => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
const get = (character: Character, id: string) => [...character.achievements, ...character.feats].find(a => a.id === id)!;
const run = (records: readonly unknown[], today = '2026-01-01', rules: CharacterConfig = config) => computeCharacter(records, rules, today);

describe('Character projection', () => {
  it('is empty without earning anything or starting a reserve', () => {
    const c = run([]);
    expect(c).toMatchObject({ xp: 0, level: 1, levelXp: 0, levelCost: 100, restedXp: 0, skippedRecords: 0 });
    expect([...c.achievements, ...c.feats].some(a => a.earned)).toBe(false);
    expect(c.professions.every(p => p.skill === 0 && p.rank === 'Apprentice')).toBe(true);
  });

  it('is byte-identical for repeated and shuffled inputs without mutating records/config', () => {
    const rows = [training(), training('2026-01-01', 'Gym', '50'), training('2026-01-01', 'Walk', '120'), learning(), task('b'), task('a', 0), training('2026-02-01')];
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    const before = JSON.stringify(config);
    const first = run(rows, '2026-02-10');
    expect(run(rows, '2026-02-10')).toEqual(first);
    expect(JSON.stringify(run([rows[3], rows[0], rows[6], rows[2], rows[5], rows[1], rows[4]], '2026-02-10'))).toBe(JSON.stringify(first));
    expect(JSON.stringify(config)).toBe(before);
  });

  it('caps training, learning, kept notes, tasks and overdue bonuses independently', () => {
    expect(run(Array.from({ length: 3 }, () => training())).xp).toBe(60);
    expect(run(Array.from({ length: 4 }, () => learning())).xp).toBe(150);
    expect(run(Array.from({ length: 6 }, (_, i) => ({ source: 'library', id: `${i}`, date: date(0) }))).xp).toBe(25);
    expect(run(Array.from({ length: 11 }, (_, i) => task(`${i}`))).xp).toBe(56);
    expect(run(Array.from({ length: 11 }, (_, i) => task(`${i}`, 6))).xp).toBe(50);
    expect(run(Array.from({ length: 4 }, (_, i) => ({ source: 'quest', id: `${i}`, date: date(0) }))).xp).toBe(60);
    expect(run([training(), training(), training(date(1))], date(1)).xp).toBe(90);
  });

  it('uses only full minutes steps with bounded bonuses and tolerant parsing', () => {
    for (const [duration, xp] of [['24:59', 30], ['25:00', 31], ['00:30:00', 32], ['120 min', 50], ['99999', 50], ['garbage', 30], ['1:99', 30], ['-10', 30]] as const) expect(run([training(date(0), 'Run', duration)]).xp).toBe(xp);
    for (const [minutes, xp] of [['1', 40], ['2', 41], ['45', 60], ['NaN', 40], ['-10', 40]] as const) expect(run([learning(date(0), minutes)]).xp).toBe(xp);
  });

  it('excludes health, distance, weight, split, score and time of day from XP', () => {
    const plain = training();
    const embellished = { ...plain, distance: '100', weight: '250', split: 'Legs', heart: 190, heartRate: 190, mood: 3, sleep: 9, steps: 50000, speed: 30, time: '02:00' };
    expect(run([embellished])).toEqual(run([plain]));
    expect(run([embellished]).xp).toBe(30);
    expect(run([{ ...learning(), score: '100' }])).toEqual(run([{ ...learning(), score: '0' }]));
    expect(run([{ source: 'health', date: date(0), mood: 3, steps: 50000 }])).toMatchObject({ xp: 0, skippedRecords: 1 });
    const output = JSON.stringify(run([embellished]));
    expect(output).not.toMatch(/decay|streak|consecutive/i);
    expect(get(run([embellished]), 'athletics-rhythm-4').progress).toBeNull();
  });

  it('accrues only full zero-XP calendar days, consumes reserve and keeps bonuses outside caps', () => {
    const rows = [training(date(0)), training(date(11)), training(date(11)), training(date(11))];
    const c = run(rows, date(11));
    expect(c).toMatchObject({ xp: 120, restedXp: 120 });
    expect(c.professions[0]!.xp).toBe(120);
    expect(get(c, 'well-rested').earnedDate).toBe(date(11));
    expect(run([training()], date(1)).restedXp).toBe(0);
    expect(run([training()], date(2)).restedXp).toBe(15);
    expect(run([training()], date(100)).restedXp).toBe(150);
    expect(run([training(), task('one', 0, date(2))], date(2))).toMatchObject({ xp: 37.5, restedXp: 12.5 });
    const exhausted = run([training(), ...Array.from({ length: 6 }, (_, i) => training(date(11 + Math.floor(i / 2)), 'Run', '120'))], date(13));
    expect(exhausted).toMatchObject({ xp: 480, restedXp: 0 });
  });

  it('earns chains with exact dates and reveals only the next unearned tier', () => {
    const rows = Array.from({ length: 25 }, (_, i) => training(date(i)));
    const c = run(rows, date(24));
    expect(get(c, 'athletics-sessions-10')).toMatchObject({ earnedDate: date(9), tier: 1, visible: true, progress: { current: 10, target: 10 } });
    expect(get(c, 'athletics-sessions-25').earnedDate).toBe(date(24));
    expect(get(c, 'athletics-sessions-50')).toMatchObject({ earned: false, visible: true, progress: { current: 25, target: 50 } });
    expect(get(c, 'athletics-sessions-100').visible).toBe(false);
    expect(get(c, 'first-steps').earnedDate).toBe(date(0));
  });

  it('hides names until earned and uses ISO weeks across year boundaries', () => {
    expect(get(run([training()]), 'long-way-back').name).toBe('???');
    expect(get(run([training(), training(date(14))], date(14)), 'long-way-back')).toMatchObject({ name: 'The Long Way Back', earnedDate: date(14) });
    const rows = [training('2025-12-29'), learning('2025-12-30'), { source: 'library', date: '2026-01-01', id: 'note' }, task('one', 0, '2026-01-04')];
    expect(get(run(rows, '2026-01-04'), 'balanced-week')).toMatchObject({ name: 'Balanced Week', earnedDate: '2026-01-04' });
    expect(get(run([...rows.slice(0, 3), task('one', 0, '2026-01-05')], '2026-01-05'), 'balanced-week').earned).toBe(false);
  });

  it('keeps weekly rhythm after a gap without exposing a resetting counter', () => {
    const rows = Array.from({ length: 12 }, (_, i) => training(date(i * 7)));
    const c = run([...rows, training(date(150))], date(200));
    for (const weeks of [4, 8, 12]) expect(get(c, `athletics-rhythm-${weeks}`)).toMatchObject({ earnedDate: date((weeks - 1) * 7), progress: null });
    expect(get(run([training(date(0)), training(date(0)), training(date(7)), training(date(21)), training(date(28))], date(28)), 'athletics-rhythm-4').earned).toBe(false);
  });

  it('evaluates metas on the completing record independent of catalogue order', () => {
    const rules: CharacterConfig = { ...config, rested: { ...config.rested, multiplier: 0 }, sources: Object.fromEntries(Object.entries(config.sources).map(([id, rule]) => [id, { profession: rule.profession, enabled: rule.enabled, identityField: rule.identityField, dailyCap: rule.dailyCap, baseXp: 1800 }])), achievements: [...config.achievements].reverse() };
    const rows = [training(), learning(date(1)), { source: 'library', date: date(2), id: 'note' }, task('one', 0, date(3))];
    const c = run(rows, date(3), rules);
    expect(get(c, 'renaissance').earnedDate).toBe(date(3));
    expect(get(c, 'jack-of-all-trades').earnedDate).toBe(date(3));
    expect(get(run(rows.slice(0, 3), date(3), rules), 'renaissance').earned).toBe(false);
    expect(c.points.total).toBe(c.achievements.filter(a => a.earned).reduce((sum, a) => sum + a.points, 0));
    expect(c.points.total).toBe(Object.values(c.points.byCategory).reduce((sum, p) => sum + p, 0));
  });

  it('keeps feats separate and Day One within seven dates of the first record', () => {
    const c = run([training(), learning(date(6))], date(6));
    expect(get(c, 'founding-hero')).toMatchObject({ earnedDate: date(0), points: 0, type: 'feat' });
    expect(get(c, 'day-one').earnedDate).toBe(date(6));
    expect(c.achievements.some(a => a.type === 'feat')).toBe(false);
    expect(get(run([training(), learning(date(7))], date(7)), 'day-one').earned).toBe(false);
  });

  it('dates variety, subject, duration and overdue criteria at their exact boundaries', () => {
    const rows = [training(date(0), 'Run'), training(date(1), 'Gym'), training(date(2), 'Walk'), training(date(3), 'Bike'), training(date(4), 'Swim')];
    const c = run(rows, date(4));
    expect(get(c, 'athletics-variety-3').earnedDate).toBe(date(2));
    expect(get(c, 'athletics-variety-5').earnedDate).toBe(date(4));
    expect(get(run([learning(date(0), '44')]), 'deep-work').earned).toBe(false);
    const study = [learning(date(0), '44'), { ...learning(date(1), '45'), kind: 'Language' }, { ...learning(date(2)), kind: 'Music' }];
    expect(get(run(study, date(2)), 'deep-work').earnedDate).toBe(date(1));
    expect(get(run(study, date(2)), 'many-subjects').earnedDate).toBe(date(2));
    expect(get(run([task('a', 29)]), 'clean-slate').earned).toBe(false);
    expect(get(run([task('a', 29), task('b', 30, date(1))], date(1)), 'clean-slate').earnedDate).toBe(date(1));
  });

  it('awards saved reflections and unlocks the reflection achievements', () => {
    const reflection = (i: number, offset = i): GameRecord => ({ source: 'reflection', date: date(offset), id: `reflection-${i}` });
    // Three reflections on one day earn only the daily cap of two, but unlock First Reflection.
    const sameDay = run([reflection(0, 0), reflection(1, 0), reflection(2, 0)], date(0));
    expect(sameDay.xp).toBe(50);
    expect(get(sameDay, 'first-reflection')).toMatchObject({ locked: false, earned: true });
    expect(get(sameDay, 'lorekeeper-reflections-10').earned).toBe(false);
    // Ten reflections across ten days reach the chain tier.
    const across = run(Array.from({ length: 10 }, (_, i) => reflection(i)), date(10));
    expect(across.xp).toBe(250);
    expect(get(across, 'lorekeeper-reflections-10')).toMatchObject({ locked: false, earned: true });
    // Guard: a disabled source is skipped, so this test fails if the config flips back to false.
    const disabled = { ...config, sources: { ...config.sources, reflection: { ...config.sources['reflection']!, enabled: false } } };
    expect(run([reflection(0, 0)], date(0), disabled).xp).toBe(0);
  });

  it('skips malformed and future records, retaining valid base XP for invalid minutes', () => {
    const c = run([null, {}, [], training('2026-02-30'), training('2026-1-01'), training(date(1)), training(date(0), ''), task('bad', -1), task('bad', NaN), { source: '__proto__', date: date(0), id: 'bad' }, training(date(0), 'Run', 'oops')]);
    expect(c).toMatchObject({ xp: 30, skippedRecords: 10 });
    expect(() => run([], 'invalid')).toThrow(RangeError);
    expect(run([training('2024-02-29')], '2024-03-01').xp).toBe(30);
  });

  it('uses exact skill milestones, level costs and maximums from config', () => {
    for (const [xp, skill, rank] of [[619, 74, 'Apprentice'], [620, 75, 'Journeyman'], [1800, 150, 'Expert'], [3545, 225, 'Artisan'], [3680, 230, 'Artisan'], [5850, 300, 'Master']] as const) {
      const rules = { ...config, sources: { ...config.sources, library: { ...config.sources['library']!, baseXp: xp } } };
      expect(run([{ source: 'library', date: date(0), id: 'note' }], date(0), rules).professions[2]).toMatchObject({ skill, rank });
    }
    const withXp = (baseXp: number) => run([{ source: 'library', date: date(0), id: 'note' }], date(0), { ...config, sources: { ...config.sources, library: { ...config.sources['library']!, baseXp } } });
    expect(withXp(100)).toMatchObject({ level: 2, levelXp: 0, levelCost: 115 });
    expect(withXp(214)).toMatchObject({ level: 2, levelXp: 114 });
    expect(withXp(31564).level).toBe(59);
    expect(withXp(31565)).toMatchObject({ level: 60, levelXp: 0, levelCost: 0 });
    expect(withXp(999999).professions[2]!.skill).toBe(300);
  });

  it('supports a new profession and tuned rules without engine changes', () => {
    const rules: CharacterConfig = { ...config, professions: [...config.professions, { id: 'maker', name: 'Maker' }], sources: { ...config.sources, craft: { profession: 'maker', enabled: true, identityField: 'id', baseXp: 8, dailyCap: 1 } }, skill: { max: 10, baseCost: 2, step: 5 }, level: { min: 1, max: 5, baseCost: 4, costStep: 2 }, rested: { perDay: 4, max: 8, multiplier: 1 }, achievements: [] };
    const c = run([{ source: 'craft', date: date(0), id: 'a' }, { source: 'craft', date: date(2), id: 'b' }], date(2), rules);
    expect(c).toMatchObject({ xp: 20, level: 4, levelXp: 2, levelCost: 10, restedXp: 0 });
    expect(c.professions.at(-1)).toMatchObject({ id: 'maker', xp: 20, skill: 8 });
  });

  it('handles 2000 synthetic rows promptly and reproduces deletion consequences', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => training(date(i)));
    const start = performance.now();
    const c = run(rows, date(1999));
    expect(performance.now() - start).toBeLessThan(2000);
    expect(c.skippedRecords).toBe(0);
    expect(c.level).toBe(60);
    expect(get(c, 'athletics-sessions-250').earnedDate).toBe(date(249));
    expect(get(run(rows.slice(0, 9), date(1999)), 'athletics-sessions-10').earned).toBe(false);
  });
});

describe('rules v3 achievement kinds (ADR-0067)', () => {
  const learn = (day: string, topic = ''): GameRecord => ({ source: 'learning', date: day, kind: 'Dictation', minutes: '', topic });
  const earned = (records: readonly GameRecord[], id: string) => get(run(records, date(400)), id).earned;
  const days = (offsets: readonly number[], make: (day: string) => GameRecord) => offsets.map(o => make(date(o)));

  it('runs need consecutive days; a rest day keeps a learning run alive once per 7 days', () => {
    expect(get(run(days([0, 1, 2], d => training(d)), date(2)), 'athletics-days-3')).toMatchObject({ earned: true, earnedDate: date(2) });
    expect(earned(days([0, 1, 3, 4], d => training(d)), 'athletics-days-3')).toBe(false);
    expect(earned(days([0, 1, 3], learn), 'scholar-daily-3')).toBe(true);
    // A second rest day within the same 7 days breaks the run (0,1,_,3,_,5): best run stays 3.
    expect(get(run(days([0, 1, 3, 5, 6, 7], learn), date(7)), 'scholar-daily-7').progress).toEqual({ current: 3, target: 7 });
    expect(earned(days([0, 1, 2, 3, 5, 6, 7, 8], learn), 'scholar-daily-7')).toBe(true);
  });

  it('weekly rhythm with a per-week minimum counts only weeks that reach it', () => {
    const twice = Array.from({ length: 4 }, (_, w) => [learn(date(4 + w * 7)), learn(date(6 + w * 7))]).flat();
    expect(earned(twice, 'scholar-rhythm-4')).toBe(true);
    expect(earned(twice.filter((_, i) => i !== 3), 'scholar-rhythm-4')).toBe(false);
    expect(earned(twice, 'athletics-rhythm-4')).toBe(false);
  });

  it('peaks count every record in a day, week or month, not only capped awards', () => {
    expect(earned(Array.from({ length: 10 }, (_, i) => task(`t${i}`, 0)), 'quartermaster-day-10')).toBe(true);
    expect(earned(Array.from({ length: 9 }, (_, i) => task(`t${i}`, 0)), 'quartermaster-day-10')).toBe(false);
    expect(earned(days([4, 5, 6], learn), 'scholar-week-3')).toBe(true);
    expect(earned(days([2, 4, 5], learn), 'scholar-week-3')).toBe(false);
    expect(earned(Array.from({ length: 12 }, (_, i) => training(date(i * 2))), 'athletics-month-12')).toBe(true);
    expect(earned(Array.from({ length: 12 }, (_, i) => training(date(i * 3))), 'athletics-month-12')).toBe(false);
  });

  it('weekends need Saturday and Sunday of the same weekend', () => {
    // 2026-01-03 is a Saturday.
    expect(earned(days([2, 3], d => training(d)), 'athletics-weekends-1')).toBe(true);
    expect(earned(days([3, 9], d => training(d)), 'athletics-weekends-1')).toBe(false);
  });

  it('distinct topics ignore case and blanks; months count any year', () => {
    expect(earned(['A', 'b', 'C', 'd', 'E'].map((t, i) => learn(date(i), t)), 'bookworm-5')).toBe(true);
    expect(earned(['A', 'a', 'B', 'C', 'D', ''].map((t, i) => learn(date(i), t)), 'bookworm-5')).toBe(false);
    expect(earned([training('2025-12-20'), training('2026-01-20'), training('2026-02-20')], 'into-the-dark')).toBe(true);
    expect(earned([training('2025-12-20'), training('2026-01-20'), training('2026-03-20')], 'into-the-dark')).toBe(false);
  });

  it('together, professions in one day and full weeks', () => {
    expect(earned([training(), learn(date(0))], 'mind-and-body-1')).toBe(true);
    expect(earned([training(), learn(date(1))], 'mind-and-body-1')).toBe(false);
    expect(earned([training(), learn(date(0)), task('x', 0)], 'triple-threat')).toBe(true);
    expect(earned([training(), learn(date(0)), task('x', 0, date(1))], 'triple-threat')).toBe(false);
    // 2026-01-05 is a Monday: XP on all 7 days of that ISO week.
    expect(earned(days([4, 5, 6, 7, 8, 9, 10], d => task(`t${d}`, 0, d)), 'full-week-1')).toBe(true);
    expect(earned(days([4, 5, 6, 7, 8, 9, 11], d => task(`t${d}`, 0, d)), 'full-week-1')).toBe(false);
  });

  it('point achievements follow the earned total', () => {
    const c = run(Array.from({ length: 25 }, (_, i) => training(date(i))), date(30));
    expect(get(c, 'achiever-100').earned).toBe(true);
    expect(get(c, 'achiever-1000')).toMatchObject({ earned: false, progress: { current: c.points.total, target: 1000 } });
    expect(get(run([training()]), 'achiever-100').progress).toEqual({ current: 10, target: 100 });
  });
});

describe('critical awards (ADR-0064)', () => {
  const tasks = (day: string, n: number): GameRecord[] => Array.from({ length: n }, (_, i) => task(`t-${day}-${i}`, 0, day));
  const days = Array.from({ length: 40 }, (_, i) => date(i));

  it('doubles base XP for the day ordinals the hash picks and counts them', () => {
    const records = days.flatMap(day => tasks(day, 5));
    const expected = days.flatMap(day => [1, 2, 3, 4, 5].filter(n => isCritical(day, 'task', n, 8))).length;
    const c = computeCharacter(records, characterConfig, days.at(-1)!);
    expect(expected).toBeGreaterThan(0);
    expect(c.criticals).toBe(expected);
    expect(c.xp).toBe(days.length * 5 * 5 + expected * 5);
  });

  it('keeps critical slots stable when identities change or a record joins a day', () => {
    const before = computeCharacter(days.flatMap(day => tasks(day, 3)), characterConfig, days.at(-1)!);
    const renamed = days.flatMap(day => tasks(day, 3).map(r => ({ ...r, id: `moved-${(r as { id: string }).id}` })));
    expect(computeCharacter(renamed, characterConfig, days.at(-1)!)).toMatchObject({ criticals: before.criticals, xp: before.xp });
    // A same-day record that sorts FIRST takes slot 1; the earlier slots keep their verdicts, one slot is added.
    const crowded = days.flatMap(day => [task(`0-${day}`, 0, day), ...tasks(day, 3)]);
    const fourth = days.filter(day => isCritical(day, 'task', 4, 8)).length;
    expect(computeCharacter(crowded, characterConfig, days.at(-1)!).criticals).toBe(before.criticals + fourth);
  });

  it('applies rested XP on top of a critical base', () => {
    const day = days.find(d => isCritical(d, 'task', 1, 8))!;
    // Ten idle days before `day` fill the reserve; the critical doubles the base, rested adds half of the doubled base.
    const c = computeCharacter([task('warm', 0, '2025-12-01'), task('x', 0, day)], characterConfig, day);
    const warm = isCritical('2025-12-01', 'task', 1, 8) ? 10 : 5;
    expect(c.criticals).toBe(1 + (warm === 10 ? 1 : 0));
    expect(c.xp).toBe(warm + 10 + 5);
  });

  it('never criticals an award beyond the daily cap', () => {
    const capped = computeCharacter(days.flatMap(day => tasks(day, 14)), characterConfig, days.at(-1)!);
    const atCap = computeCharacter(days.flatMap(day => tasks(day, 10)), characterConfig, days.at(-1)!);
    expect(capped.criticals).toBe(atCap.criticals);
    expect(capped.xp).toBe(atCap.xp);
  });

  it('is off when every is 0', () => {
    expect(computeCharacter(days.flatMap(day => tasks(day, 5)), config, days.at(-1)!).criticals).toBe(0);
  });

  it('records which source earned each achievement', () => {
    const c = computeCharacter([training('2026-01-01'), task('a', 0, '2026-01-02')], config, '2026-01-02');
    expect(get(c, 'athletics-first')).toMatchObject({ earned: true, earnedBy: 'training' });
    expect(get(c, 'first-steps').earnedBy).toBe('training');
    expect(get(c, 'quartermaster-tasks-10')).toMatchObject({ earned: false, earnedBy: null });
    expect(earnedByPhrase('task')).toBe('Completing a task');
    expect(earnedByPhrase(null)).toBeNull();
  });
});
