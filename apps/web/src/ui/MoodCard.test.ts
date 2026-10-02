import type { Command } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { moodCheckin, undoMoodCheckinDraft } from '../commands.ts';
import type { QueueItem } from '../queue/queue.ts';
import { chipLabel, latestCheckin, localDate, parseSleep } from './MoodCard.tsx';

const ACCOUNT = 'a'.repeat(64);
const ctx = { baseRevision: '1'.repeat(40) };

function queued(envelope: Command, seq: number): QueueItem {
  return {
    operationId: envelope.operationId,
    seq,
    type: envelope.type,
    envelope,
    label: `Mood \u00b7 2026-10-02`,
    taskKey: 'mood',
    accountKey: ACCOUNT,
    state: 'pending',
    error: null,
    everSent: false,
    accountMismatch: false,
    receipt: null,
    acknowledged: false,
  };
}

const checkin = () => moodCheckin(ctx, { date: '2026-10-02', mood: 1, energy: -2, sleep: 7.5, checkinAt: '2026-10-02T06:14:00.000Z' });

describe('sleep parse (B1: dot or Danish comma, 0.5 steps)', () => {
  it('accepts a dot and a comma, and the 0 and 24 boundaries', () => {
    expect(parseSleep('7.5')).toBe(7.5);
    expect(parseSleep('7,5')).toBe(7.5);
    expect(parseSleep(' 8 ')).toBe(8);
    expect(parseSleep('0')).toBe(0);
    expect(parseSleep('24')).toBe(24);
    expect(parseSleep('0,5')).toBe(0.5);
    expect(parseSleep('7.0')).toBe(7);
  });
  it('rejects anything off the 0.5-hour grid or out of range', () => {
    for (const bad of ['', 'abc', '-1', '24.5', '7.25', '1e1']) expect(Number.isNaN(parseSleep(bad)), bad).toBe(true);
  });
});

describe('chip copy', () => {
  it('labels the mood scale with the contract minus sign', () => {
    expect(chipLabel('Mood', -3)).toBe('Mood \u22123');
    expect(chipLabel('Mood', 0)).toBe('Mood 0');
    expect(chipLabel('Mood', 3)).toBe('Mood +3');
    expect(chipLabel('Energy', 2)).toBe('Energy +2');
  });
});

describe('collapsed-state derivation', () => {
  it('is null without a check-in for the day', () => {
    expect(latestCheckin([], '2026-10-02')).toBeNull();
    const other = moodCheckin(ctx, { date: '2026-10-01', mood: 0, energy: 0, sleep: 8, checkinAt: '2026-10-01T06:00:00.000Z' });
    expect(latestCheckin([queued(other, 1)], '2026-10-02')).toBeNull();
  });
  it('returns the newest check-in for the date', () => {
    const first = checkin();
    const second = moodCheckin(ctx, { date: '2026-10-02', mood: -1, energy: 3, sleep: 6, checkinAt: '2026-10-02T18:00:00.000Z' });
    expect(latestCheckin([queued(first, 1), queued(second, 2)], '2026-10-02')).toMatchObject({ mood: -1, sleep: 6 });
  });
  it('returns null once an UndoMoodCheckin targets it, so the form comes back', () => {
    const target = checkin();
    const undo = undoMoodCheckinDraft(ctx, target);
    expect(latestCheckin([queued(target, 1), queued(undo, 2)], '2026-10-02')).toBeNull();
  });
});

it('derives the local calendar date', () => {
  expect(localDate(new Date(2026, 9, 2, 23, 30))).toBe('2026-10-02');
});
