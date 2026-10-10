import { expect, it } from 'vitest';
import { catalogueErrors } from './catalogue.ts';
import { characterConfig } from './config.ts';

it('has unique ids and reachable thresholds with rulesVersion 1', () => {
  expect(characterConfig.rulesVersion).toBe(1);
  expect(catalogueErrors(characterConfig)).toEqual([]);
  expect(new Set(characterConfig.achievements.map(a => a.id)).size).toBe(characterConfig.achievements.length);
  expect(characterConfig.achievements.length).toBeGreaterThanOrEqual(45);
  expect(characterConfig.achievements.every(a => a.type === 'feat' ? a.points === 0 : [5, 10, 25, 50].includes(a.points))).toBe(true);
  for (const a of characterConfig.achievements) {
    if (a.chain) expect(characterConfig.achievements.filter(b => b.chain === a.chain).map(b => b.tier)).toEqual(Array.from({ length: characterConfig.achievements.filter(b => b.chain === a.chain).length }, (_, i) => i + 1));
  }
});

it('rejects collisions, impossible skill/level/profession targets, unavailable sources and broken metas', () => {
  const first = characterConfig.achievements[0]!;
  expect(catalogueErrors({ ...characterConfig, achievements: [first, first] })).toContain(`Duplicate achievement: ${first.id}`);
  expect(catalogueErrors({ ...characterConfig, skill: { ...characterConfig.skill, max: 299 } })).toContain('Unreachable skill: athletics-rank-300');
  expect(catalogueErrors({ ...characterConfig, level: { ...characterConfig.level, max: 59 } })).toContain('Unreachable level: rising-hero-60');
  expect(catalogueErrors({ ...characterConfig, professions: characterConfig.professions.slice(0, 3) })).toContain('Unreachable professions: balanced-week');
  expect(catalogueErrors({ ...characterConfig, achievements: [{ ...first, criterion: { kind: 'count', source: 'absent', target: 1 } }] })).toContain('Unavailable source: first-steps');
  expect(catalogueErrors({ ...characterConfig, achievements: [{ ...first, criterion: { kind: 'meta', requires: ['missing'] } }] })).toContain('Missing dependency: missing');
  expect(catalogueErrors({ ...characterConfig, achievements: [{ ...first, criterion: { kind: 'meta', requires: [first.id] } }] })).toContain('Cyclic meta: first-steps');
  expect(catalogueErrors({ ...characterConfig, achievements: [{ ...first, criterion: { kind: 'founding', target: 2 } }] })).toContain('Unreachable founding: first-steps');
  expect(catalogueErrors({ ...characterConfig, rested: { ...characterConfig.rested, max: 0 } })).toContain('Unreachable rested: well-rested');
  expect(catalogueErrors({ ...characterConfig, achievements: [{ ...first, criterion: { kind: 'minutes', source: 'library', target: 45 } }] })).toContain('Unavailable minutes: first-steps');
});
