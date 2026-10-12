import { describe, expect, it } from 'vitest';
import { CHECKIN_START, checkinCopy, checkinNext, checkinOptions, targetName, targetText, type CheckinStep } from './checkin-step.ts';

const pick = (state: CheckinStep, value: number) => checkinNext(state, { kind: 'pick', value });

describe('inline check-in step machine (R3b)', () => {
  it('asks mood, then energy, then sleep, and is ready only with all three', () => {
    const energy = pick(CHECKIN_START, 2);
    expect(energy).toEqual({ step: 'energy', mood: 2 });
    const sleep = pick(energy, -1);
    expect(sleep).toEqual({ step: 'sleep', mood: 2, energy: -1 });
    expect(pick(sleep, 7)).toEqual({ step: 'ready', mood: 2, energy: -1, sleep: 7 });
  });

  it('ignores a value the step does not offer (no ±3 inline, no sleep value as a mood)', () => {
    expect(pick(CHECKIN_START, 3)).toBe(CHECKIN_START);
    expect(pick(CHECKIN_START, 7)).toBe(CHECKIN_START);
    const sleep: CheckinStep = { step: 'sleep', mood: 0, energy: 0 };
    expect(pick(sleep, 0)).toBe(sleep);
    expect(pick(sleep, 7.5)).toBe(sleep);
  });

  it('Back undoes only the last answer', () => {
    expect(checkinNext({ step: 'sleep', mood: 1, energy: -2 }, { kind: 'back' })).toEqual({ step: 'energy', mood: 1 });
    expect(checkinNext({ step: 'energy', mood: 1 }, { kind: 'back' })).toEqual(CHECKIN_START);
    expect(checkinNext(CHECKIN_START, { kind: 'back' })).toBe(CHECKIN_START);
  });

  it('a ready state takes no further pick', () => {
    const ready: CheckinStep = { step: 'ready', mood: 0, energy: 0, sleep: 8 };
    expect(checkinOptions(ready)).toEqual([]);
    expect(pick(ready, 6)).toBe(ready);
  });

  it('offers five targets per step', () => {
    expect(checkinOptions(CHECKIN_START)).toEqual([-2, -1, 0, 1, 2]);
    expect(checkinOptions({ step: 'energy', mood: 0 })).toEqual([-2, -1, 0, 1, 2]);
    expect(checkinOptions({ step: 'sleep', mood: 0, energy: 0 })).toEqual([5, 6, 7, 8, 9]);
  });
});

describe('inline check-in copy', () => {
  it('names each step and carries the earlier answers as the Back control', () => {
    expect(checkinCopy(CHECKIN_START)).toEqual({ prompt: 'How are you today?', kind: 'Mood', ends: ['low', 'great'], answered: null });
    expect(checkinCopy({ step: 'energy', mood: 2 })).toMatchObject({ prompt: 'Energy?', kind: 'Energy', ends: ['drained', 'energised'], answered: 'Mood +2' });
    expect(checkinCopy({ step: 'sleep', mood: 2, energy: -1 })).toMatchObject({ prompt: 'Sleep?', kind: 'Sleep', answered: 'Mood +2 · Energy −1' });
  });

  it('labels targets from the existing scale', () => {
    expect([-2, 0, 2].map((v) => targetText('Mood', v))).toEqual(['−2', '0', '+2']);
    expect(targetName('Energy', -1)).toBe('Energy −1');
    expect(targetText('Sleep', 7)).toBe('7');
    expect(targetName('Sleep', 7)).toBe('Sleep 7 hours');
  });
});
