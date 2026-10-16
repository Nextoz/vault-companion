// Redesign R4: the pure decisions behind the Character skin (tier -> quality, the locked arc, category -> glyph).
import { describe, expect, it } from 'vitest';
import { achievementQuality, bannerQuality, categoryGlyph, lockedArc, qualityForPoints, qualityLabel, remainingText } from './character-skin.ts';

const progress = (current: number, target: number) => ({ current, target });

describe('tier -> item quality', () => {
  it('maps the catalogue tiers 5 / 10 / 25 / 50 to common, uncommon, rare, epic', () => {
    expect([5, 10, 25, 50].map(qualityForPoints)).toEqual(['common', 'uncommon', 'rare', 'epic']);
  });

  it('a value between tiers takes the tier below it', () => {
    expect([9, 15, 24, 30, 49, 120].map(qualityForPoints)).toEqual(['common', 'uncommon', 'uncommon', 'rare', 'rare', 'epic']);
  });

  it('a Feat of Strength is legendary whatever its points', () => {
    expect(achievementQuality({ type: 'feat', points: 0 })).toBe('legendary');
    expect(achievementQuality({ type: 'feat', points: 50 })).toBe('legendary');
    expect(achievementQuality({ type: 'meta', points: 25 })).toBe('rare');
  });

  it('the banner reads 0 points as a Feat, otherwise the points tier', () => {
    expect(bannerQuality(0)).toBe('legendary');
    expect(bannerQuality(10)).toBe('uncommon');
    expect(bannerQuality(50)).toBe('epic');
  });

  it('names the quality for the detail sheet', () => {
    expect(qualityLabel('epic')).toBe('Epic');
  });
});

describe('locked progress arc', () => {
  it('draws current / target for an unearned, visible achievement', () => {
    expect(lockedArc({ type: 'counter', earned: false, visible: true, progress: progress(18, 25) })).toBeCloseTo(0.72);
  });

  it('no arc once earned, while hidden, or without measurable progress', () => {
    expect(lockedArc({ type: 'counter', earned: true, visible: true, progress: progress(10, 10) })).toBeNull();
    expect(lockedArc({ type: 'counter', earned: false, visible: false, progress: progress(3, 14) })).toBeNull();
    expect(lockedArc({ type: 'counter', earned: false, visible: true, progress: null })).toBeNull();
    expect(lockedArc({ type: 'counter', earned: false, visible: true, progress: progress(0, 0) })).toBeNull();
  });

  it('no arc and nothing left for an engine-shaped hidden achievement (visible, but type hidden)', () => {
    expect(lockedArc({ type: 'hidden', earned: false, visible: true, progress: progress(1, 4) })).toBeNull();
    expect(remainingText({ type: 'hidden', earned: false, visible: true, progress: progress(1, 4) })).toBeNull();
  });

  it('clamps to 0..1 when the payload over- or under-shoots', () => {
    expect(lockedArc({ type: 'counter', earned: false, visible: true, progress: progress(40, 25) })).toBe(1);
    expect(lockedArc({ type: 'counter', earned: false, visible: true, progress: progress(-2, 25) })).toBe(0);
  });

  it('says what is left, and nothing when there is nothing to count', () => {
    expect(remainingText({ type: 'counter', earned: false, visible: true, progress: progress(4, 7) })).toBe('3 to go');
    expect(remainingText({ type: 'counter', earned: false, visible: true, progress: progress(7, 7) })).toBeNull();
    expect(remainingText({ type: 'counter', earned: true, visible: true, progress: progress(4, 7) })).toBeNull();
    expect(remainingText({ type: 'counter', earned: false, visible: false, progress: progress(0, 14) })).toBeNull();
  });
});

describe('category -> glyph', () => {
  it('maps the domain categories and the app words to one glyph each, case-insensitively', () => {
    expect(categoryGlyph('athletics')).toBe('athletics');
    expect(categoryGlyph('Training')).toBe('athletics');
    expect(categoryGlyph('Learning')).toBe('scholar');
    expect(categoryGlyph('quartermaster')).toBe('quartermaster');
    expect(categoryGlyph('lorekeeper')).toBe('lorekeeper');
    expect(categoryGlyph('Feats')).toBe('feats');
    expect(categoryGlyph('Journey')).toBe('journey');
  });

  it('an unknown category falls back to the general medal', () => {
    expect(categoryGlyph('Something new')).toBe('general');
    expect(categoryGlyph('')).toBe('general');
  });
});
