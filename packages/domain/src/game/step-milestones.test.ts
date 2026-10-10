// Journey step milestones (owner decision 10 Oct 2026): points, never XP. Synthetic rows only.
import { describe, expect, it } from 'vitest';
import { characterConfig } from './config.ts';
import { computeStepMilestones, type StepDay } from './step-milestones.ts';

const day = (date: string, steps: number | null): StepDay => ({ date, steps });
const run = (days: readonly StepDay[]) => computeStepMilestones(days, characterConfig);
const ids = (days: readonly StepDay[]) => run(days).earned.map((milestone) => `${milestone.id}@${milestone.earnedDate}`);

describe('computeStepMilestones', () => {
  it('earns a threshold on the exact boundary day the running total reaches it', () => {
    const result = run([day('2024-01-05', 99_999), day('2024-01-06', 1)]);
    expect(result.earned).toEqual([
      { id: 'steps-lifetime-100000', name: '100K Steps', category: 'Journey', points: 5, ladder: 'lifetime', target: 100_000, earnedDate: '2024-01-06', year: null },
    ]);
    expect(result.next).toEqual({ id: 'steps-lifetime-250000', name: '250K Steps', current: 100_000, target: 250_000 });
    expect(result.retroactiveSummary).toEqual({ count: 1, firstYear: 2024 });
  });

  it('skips blank days and never guesses them', () => {
    const result = run([day('2024-01-05', 100_000), day('2024-01-06', null), day('2024-01-07', null)]);
    expect(result.earned).toHaveLength(1);
    expect(result.earned[0]!.earnedDate).toBe('2024-01-05');
    expect(result.next.current).toBe(100_000);
  });

  it('separates each calendar year and survives a year rollover', () => {
    // 900k in 2024 and 200k in 2025: neither year reaches 1M, but the lifetime total crosses several rungs.
    expect(ids([day('2024-12-30', 900_000), day('2025-01-02', 200_000)])).toEqual([
      'steps-lifetime-100000@2024-12-30', 'steps-lifetime-250000@2024-12-30', 'steps-lifetime-500000@2024-12-30', 'steps-lifetime-1000000@2025-01-02',
    ]);
    // Each year earns its own 1M yearly milestone: the id carries the year, so neither masks the other.
    const rollover = run([day('2024-06-01', 1_000_000), day('2025-02-01', 1_000_000)]);
    expect(rollover.earned.map((milestone) => [milestone.id, milestone.year, milestone.earnedDate])).toEqual([
      ['steps-lifetime-100000', null, '2024-06-01'],
      ['steps-lifetime-250000', null, '2024-06-01'],
      ['steps-lifetime-500000', null, '2024-06-01'],
      ['steps-lifetime-1000000', null, '2024-06-01'],
      ['steps-yearly-1000000-2024', 2024, '2024-06-01'],
      ['steps-yearly-1000000-2025', 2025, '2025-02-01'],
    ]);
  });

  it('continues the lifetime ladder every 2.5M steps past the explicit thresholds', () => {
    const result = run([day('2024-03-01', 12_500_000)]);
    expect(result.earned.find((milestone) => milestone.ladder === 'lifetime' && milestone.target === 12_500_000))
      .toMatchObject({ id: 'steps-lifetime-12500000', name: '12.5M Steps', earnedDate: '2024-03-01' });
    expect(result.next).toMatchObject({ id: 'steps-lifetime-15000000', current: 12_500_000, target: 15_000_000 });
  });

  it('has no summary and the first rung as `next` when nothing was crossed', () => {
    const result = run([day('2024-01-05', 0), day('2024-01-06', null)]);
    expect(result.earned).toEqual([]);
    expect(result.retroactiveSummary).toBeNull();
    expect(result.next).toEqual({ id: 'steps-lifetime-100000', name: '100K Steps', current: 0, target: 100_000 });
  });

  it('is deterministic regardless of row order and ignores malformed or negative rows', () => {
    const rows = [day('2024-01-07', 60_000), day('2024-01-05', 40_000), day('2024-01-06', 1)];
    expect(run(rows)).toEqual(run([...rows].reverse()));
    expect(run([{ date: 'bad', steps: 10_000_000 }, day('2024-01-05', -5), day('2024-01-06', Number.NaN), day('2024-01-07', 1)])).toEqual(run([day('2024-01-07', 1)]));
  });
});
