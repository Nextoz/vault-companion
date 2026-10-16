import { describe, expect, it } from 'vitest';
import { FRESH_FOR_MS } from './freshness.ts';
import {
  FAB_JITTER, FAB_TOP_ZONE, fabScroll, fabVerb, logTabSuffix, PULL_THRESHOLD, pullArmed, pullDistance, stripFractions,
  stripMotion, vaultChip,
} from './nav.ts';

describe('fabVerb: the capture button names what it adds', () => {
  it('says Training, Session and Reading on those Log screens', () => {
    expect(fabVerb('training')).toEqual({ verb: 'Training', label: 'Add training' });
    expect(fabVerb('learning')).toEqual({ verb: 'Session', label: 'Add session' });
    expect(fabVerb('reading')).toEqual({ verb: 'Reading', label: 'Log reading' });
  });

  it('says Capture everywhere else, Progress and Health included', () => {
    for (const tab of ['today', 'tasks', 'all', 'scouts', 'notes', 'history', 'health', 'status', 'radar'] as const) {
      expect(fabVerb(tab)).toEqual({ verb: 'Capture', label: 'Capture' });
    }
  });

  it('keeps the visible word inside the accessible name', () => {
    for (const tab of ['training', 'learning', 'reading', 'today'] as const) {
      const { verb, label } = fabVerb(tab);
      expect(label.toLowerCase()).toContain(verb.toLowerCase());
    }
  });
});

describe('fabScroll: circle while scrolling down, pill on the way up and at the top', () => {
  const rest = { compact: false, anchor: 0 };

  it('shrinks once the page moves down past the jitter', () => {
    expect(fabScroll(rest, 100).compact).toBe(true);
  });

  it('ignores movement within the jitter', () => {
    const down = fabScroll(rest, 200);
    expect(fabScroll(down, 200 - FAB_JITTER)).toBe(down);
    expect(fabScroll(down, 200 + FAB_JITTER)).toBe(down);
  });

  it('extends again on a scroll up', () => {
    const down = fabScroll(rest, 300);
    expect(fabScroll(down, 300 - FAB_JITTER - 1).compact).toBe(false);
  });

  it('is always extended at the top, even right after a downward move', () => {
    expect(fabScroll({ compact: true, anchor: 0 }, FAB_TOP_ZONE).compact).toBe(false);
    expect(fabScroll({ compact: true, anchor: 500 }, 0).compact).toBe(false);
  });
});

describe('pull to refresh', () => {
  it('arms at exactly the 70 px threshold, not before', () => {
    expect(PULL_THRESHOLD).toBe(70);
    expect(pullArmed(69)).toBe(false);
    expect(pullArmed(70)).toBe(true);
  });

  it('counts only a pull that began at the top of the page', () => {
    expect(pullDistance(100, 200, 0)).toBe(100);
    expect(pullDistance(100, 200, 1)).toBe(0);
  });

  it('never goes negative when the finger moves up', () => {
    expect(pullDistance(200, 150, 0)).toBe(0);
  });
});

describe('vaultChip', () => {
  const now = 1_000_000_000;

  it('is red after a failed read', () => {
    expect(vaultChip(now, true, now)).toEqual({ tone: 'red', text: 'Not refreshed' });
  });

  it('is yellow once the last good read is older than the freshness window', () => {
    expect(vaultChip(now - FRESH_FOR_MS - 1, false, now)).toEqual({ tone: 'yellow', text: 'Stale' });
    expect(vaultChip(now - FRESH_FOR_MS, false, now)).toBeNull();
  });

  it('shows nothing before the first read', () => {
    expect(vaultChip(null, false, now)).toBeNull();
  });
});

describe('stripFractions', () => {
  it('fills XP into the level and starts the rested run at the fill end', () => {
    const f = stripFractions({ level: 12, levelXp: 156, levelCost: 265, restedXp: 90 });
    expect(f.fill).toBeCloseTo(156 / 265, 6);
    expect(f.restedStart).toBeCloseTo(156 / 265, 6);
    expect(f.restedWidth).toBeCloseTo(90 / 265, 6);
    expect(f.rested).toBe(true);
  });

  it('clamps the rested run at the level end', () => {
    const f = stripFractions({ level: 3, levelXp: 80, levelCost: 100, restedXp: 500 });
    expect(f.fill).toBeCloseTo(0.8, 6);
    expect(f.restedWidth).toBeCloseTo(0.2, 6);
    expect(f.restedStart + f.restedWidth).toBeCloseTo(1, 6);
  });

  it('never overfills the level', () => {
    expect(stripFractions({ level: 3, levelXp: 140, levelCost: 100, restedXp: 0 }).fill).toBe(1);
  });

  it('is full with no reserve and no zz at the level cap', () => {
    expect(stripFractions({ level: 60, levelXp: 0, levelCost: 0, restedXp: 40 })).toEqual({ fill: 1, restedStart: 1, restedWidth: 0, rested: false });
  });

  it('shows no zz without a rested reserve', () => {
    expect(stripFractions({ level: 3, levelXp: 10, levelCost: 100, restedXp: 0 }).rested).toBe(false);
  });
});

describe('stripMotion', () => {
  const at = (levelXp: number, level = 5, restedXp = 0) => ({ level, levelXp, levelCost: 100, restedXp });

  it('uses the reward ease for an XP gain within the level', () => {
    expect(stripMotion(at(10), at(30))).toBe('reward');
  });

  it('uses the interface ease for a drop (an Undo)', () => {
    expect(stripMotion(at(30), at(10))).toBe('ui');
  });

  it('jumps on the first value and on a new level', () => {
    expect(stripMotion(null, at(10))).toBe('none');
    expect(stripMotion(at(90, 5), at(5, 6))).toBe('none');
  });

  it('does not move for an identical value', () => {
    expect(stripMotion(at(30), at(30))).toBe('none');
    expect(stripMotion(at(30, 5, 0), at(30, 5, 20))).toBe('ui');
  });
});

describe('logTabSuffix', () => {
  it('reads "Log, level 12" once the level is known, plain "Log" before', () => {
    expect(`Log${logTabSuffix(12)}`).toBe('Log, level 12');
    expect(`Log${logTabSuffix(null)}`).toBe('Log');
  });
});
