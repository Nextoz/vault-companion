import { describe, expect, it } from 'vitest';
import { dismissDuration, dragOffset, releaseDecision, releaseVelocity } from './sheet-drag.ts';

const H = 600;

describe('dragOffset', () => {
  it('follows the finger 1:1 downward', () => {
    expect(dragOffset(120, H)).toBe(120);
  });

  it('rubber-bands upward: the sheet moves less than the finger and never past its height', () => {
    const up = dragOffset(-100, H);
    expect(up).toBeLessThan(0);
    expect(up).toBeGreaterThan(-100);
    expect(up).toBeCloseTo(-50.38, 1);
    expect(dragOffset(-100_000, H)).toBeGreaterThan(-H);
  });
});

describe('releaseVelocity', () => {
  it('measures only the last 100 ms, so a slow drag ending in a flick reads as a flick', () => {
    const samples = [{ t: 0, y: 0 }, { t: 900, y: 10 }, { t: 950, y: 40 }, { t: 1000, y: 70 }];
    expect(releaseVelocity(samples)).toBeCloseTo(0.6, 5);
  });

  it('is 0 for a single sample', () => {
    expect(releaseVelocity([{ t: 5, y: 5 }])).toBe(0);
  });
});

describe('releaseDecision', () => {
  it('dismisses past 25% of the sheet height, and springs back short of it', () => {
    expect(releaseDecision({ offset: 151, height: H, velocity: 0 })).toBe('dismiss');
    expect(releaseDecision({ offset: 149, height: H, velocity: 0 })).toBe('restore');
  });

  it('a downward flick dismisses a short drag', () => {
    expect(releaseDecision({ offset: 40, height: H, velocity: 0.6 })).toBe('dismiss');
  });

  it('an upward flick springs back even past the threshold', () => {
    expect(releaseDecision({ offset: 300, height: H, velocity: -0.8 })).toBe('restore');
  });

  it('a jittery tap is not a flick', () => {
    expect(releaseDecision({ offset: 4, height: H, velocity: 2 })).toBe('restore');
  });
});

describe('dismissDuration', () => {
  it('a fast flick leaves faster than the full duration, but never instantly', () => {
    expect(dismissDuration({ offset: 100, height: H, velocity: 4, max: 280 })).toBe(140);
    expect(dismissDuration({ offset: 100, height: H, velocity: 2, max: 280 })).toBe(250);
  });

  it('a slow release or a button tap takes the full duration', () => {
    expect(dismissDuration({ offset: 0, height: H, velocity: 0, max: 280 })).toBe(280);
    expect(dismissDuration({ offset: 200, height: H, velocity: 0.1, max: 280 })).toBe(280);
    expect(dismissDuration({ offset: 200, height: H, velocity: -0.3, max: 280 })).toBe(280);
  });
});
