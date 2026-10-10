import { describe, expect, it } from 'vitest';
import { computeCharacter } from './engine.ts';
import { characterConfig as config } from './config.ts';
import type { Character, CharacterConfig, GameRecord } from './types.ts';

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
    expect(run(Array.from({ length: 4 }, () => learning())).xp).toBe(75);
    expect(run(Array.from({ length: 6 }, (_, i) => ({ source: 'library', id: `${i}`, date: date(0) }))).xp).toBe(25);
    expect(run(Array.from({ length: 6 }, (_, i) => task(`${i}`))).xp).toBe(21);
    expect(run(Array.from({ length: 6 }, (_, i) => task(`${i}`, 6))).xp).toBe(15);
    expect(run([training(), training(), training(date(1))], date(1)).xp).toBe(90);
  });

  it('uses only full minutes steps with bounded bonuses and tolerant parsing', () => {
    for (const [duration, xp] of [['24:59', 30], ['25:00', 31], ['00:30:00', 32], ['120 min', 50], ['99999', 50], ['garbage', 30], ['1:99', 30], ['-10', 30]] as const) expect(run([training(date(0), 'Run', duration)]).xp).toBe(xp);
    for (const [minutes, xp] of [['1', 15], ['2', 16], ['45', 30], ['NaN', 15], ['-10', 15]] as const) expect(run([learning(date(0), minutes)]).xp).toBe(xp);
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
    expect(run([training(), task('one', 0, date(2))], date(2))).toMatchObject({ xp: 34.5, restedXp: 13.5 });
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

  it('does not award disabled reflections or locked achievements', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ source: 'reflection', date: date(i), id: `reflection-${i}` }));
    const c = run(rows, date(10));
    expect(c.xp).toBe(0);
    for (const id of ['first-reflection', 'lorekeeper-reflections-10']) expect(get(c, id)).toMatchObject({ locked: true, earned: false, progress: { current: 0 } });
    const enabled = { ...config, sources: { ...config.sources, reflection: { ...config.sources['reflection']!, enabled: true } } };
    const unlockedSource = run(rows, date(10), enabled);
    expect(unlockedSource.xp).toBe(250);
    expect(get(unlockedSource, 'first-reflection').earned).toBe(false);
    expect(run([rows[0], rows[0], rows[0]], date(0), enabled).xp).toBe(50);
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
