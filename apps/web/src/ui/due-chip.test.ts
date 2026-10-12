import { describe, expect, it } from 'vitest';
import { dueChip } from './due-chip.ts';

describe('dueChip', () => {
  it('says Today for a task due today', () => {
    expect(dueChip('2026-09-24', '2026-09-24')).toEqual({ text: 'Today', tone: 'today' });
  });
  it('counts overdue days, across a month edge', () => {
    expect(dueChip('2026-09-20', '2026-09-24')).toEqual({ text: '4d late', tone: 'over' });
    expect(dueChip('2026-09-30', '2026-10-02')).toEqual({ text: '2d late', tone: 'over' });
  });
  it('names tomorrow and counts later days', () => {
    expect(dueChip('2026-09-25', '2026-09-24')).toEqual({ text: 'Tomorrow', tone: 'soon' });
    expect(dueChip('2026-09-29', '2026-09-24')).toEqual({ text: 'in 5d', tone: 'soon' });
  });
  it('has no chip without a usable due date', () => {
    expect(dueChip(null, '2026-09-24')).toBeNull();
    expect(dueChip('', '2026-09-24')).toBeNull();
    expect(dueChip('not a date', '2026-09-24')).toBeNull();
  });
});
