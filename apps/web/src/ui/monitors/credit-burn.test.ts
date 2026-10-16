// M1a: synthetic tests for the Credit burn-down projection. No vault text, no DOM: numbers only, parsed through the
// same contracts the app receives so a contract change fails here first.
import { AiBudgetResponse, AiUsageResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { creditBurn, type CreditBurnView } from './credit-burn.ts';

const REV = 'a'.repeat(40);
const TZ = 'Europe/Copenhagen';
const NOW = Date.parse('2026-10-16T12:00:00+02:00');
const RESET = '2026-11-01T00:59:59+01:00'; // 01:59:59 local, so the vault day is still 31 Oct.
const TODAY = '2026-10-16';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysAgo = (count: number) => iso(Date.parse(`${TODAY}T00:00:00Z`) - count * DAY);

interface UsageDay { date: string; calls: number; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; cost: number; }
const day = (date: string, cost: number): UsageDay =>
  ({ date, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost });
/** `cost` on each of the last seven local days, oldest first. */
const week = (cost: number) => Array.from({ length: 7 }, (_, index) => day(daysAgo(6 - index), cost));

const budgetOf = (providers: unknown[], generatedAt = '2026-10-16T11:30:00+02:00') =>
  AiBudgetResponse.parse({ revision: REV, generatedAt, providers, freeRamGb: null });
const scaleway = (value = 63, resetsAt: string | null = RESET) =>
  ({ id: 'scaleway', label: 'Scaleway', kind: 'money', value, limit: 100, unit: '€', resetsAt, history: null });
const claude = { id: 'claude', label: 'Claude weekly', kind: 'percent', value: 92, limit: 100, unit: null, resetsAt: null, history: null };
const usageOf = (days: UsageDay[]) =>
  AiUsageResponse.parse({ revision: REV, generatedAt: '2026-10-16T11:30:00+02:00', skipped: 0, providers: { scaleway: { label: 'Scaleway', currency: 'EUR', days } } });

const ok = (view: CreditBurnView) => {
  if (view.kind !== 'ok') throw new Error(`expected ok, got ${view.reason}`);
  return view;
};

describe('creditBurn', () => {
  it('reads 63 EUR left against 2 EUR/day as on pace for 31 Oct', () => {
    const view = ok(creditBurn(budgetOf([scaleway()]), usageOf(week(2)), NOW, TZ));
    expect(view.burn?.avgPerDay).toBe(2);
    expect(view.burn?.recordedDays).toBe(7);
    expect(view.burn?.onPace).toBe(true);
    expect(view.burn?.paceText).toBe('On pace: ~EUR 32 left on 31 Oct');
    expect(view.summary).toBe('Scaleway EUR 63 left · 16 d · on pace');
    expect(view.expiresLabel).toBe('31 Oct');
    expect(view.daysLeft).toBe(16);
    expect(view.left).toBe(63);
    expect(view.limit).toBe(100);
    expect(view.unit).toBe('EUR');
    expect(view.ring.fraction).toBeCloseTo(0.63);
  });

  it('flags a 5 EUR/day burn as short of the voucher', () => {
    const view = ok(creditBurn(budgetOf([scaleway()]), usageOf(week(5)), NOW, TZ));
    expect(view.burn?.onPace).toBe(false);
    expect(view.burn?.paceText.startsWith('Short ~EUR')).toBe(true);
    expect(view.summary.startsWith('Scaleway EUR 63 left · 16 d · short ~EUR')).toBe(true);
  });

  it('averages only over the days the file recorded', () => {
    const days = [day(daysAgo(2), 3), day(daysAgo(1), 3), day(daysAgo(0), 3)];
    const view = ok(creditBurn(budgetOf([scaleway()]), usageOf(days), NOW, TZ));
    expect(view.burn?.recordedDays).toBe(3);
    expect(view.burn?.avgPerDay).toBe(3);
    expect(view.burn?.onPace).toBe(true);
  });

  it('says the pace is unknown when no scaleway day was recorded', () => {
    const view = ok(creditBurn(budgetOf([scaleway()]), usageOf([]), NOW, TZ));
    expect(view.burn).toBeNull();
    expect(view.summary.endsWith('pace unknown')).toBe(true);
    expect(view.chart.points).toEqual([]);
    expect(view.ring.fraction).toBeCloseTo(0.63);
  });

  it('marks a three-hour-old budget as stale', () => {
    const view = ok(creditBurn(budgetOf([scaleway()], '2026-10-16T09:00:00+02:00'), usageOf(week(2)), NOW, TZ));
    expect(view.freshness?.stale).toBe(true);
    expect(view.freshness?.text.startsWith('Scaleway console · vendor APIs · ')).toBe(true);
  });

  it('refuses with a reason when the budget or the voucher is missing', () => {
    const missingRow = creditBurn(budgetOf([claude]), usageOf(week(2)), NOW, TZ);
    expect(missingRow.kind).toBe('unavailable');
    expect(missingRow).toMatchObject({ reason: 'No Scaleway voucher in the budget file.' });
    expect(missingRow.freshness).not.toBeNull();
    expect(creditBurn(null, null, NOW, TZ)).toMatchObject({ kind: 'unavailable', reason: 'AI budget could not be read.', freshness: null });
    const noExpiry = creditBurn(budgetOf([scaleway(63, null)]), usageOf(week(2)), NOW, TZ);
    expect(noExpiry).toMatchObject({ kind: 'unavailable', reason: 'The Scaleway voucher has no expiry date in the budget file.' });
    const expired = creditBurn(budgetOf([scaleway(63, '2026-10-15T00:59:59+02:00')]), usageOf(week(2)), NOW, TZ);
    expect(expired).toMatchObject({ kind: 'unavailable', reason: 'The Scaleway voucher has expired.' });
  });

  it('reconstructs the balance backwards, oldest first', () => {
    const days = [day(daysAgo(1), 1), day(daysAgo(0), 2)];
    const view = ok(creditBurn(budgetOf([scaleway(10)]), usageOf(days), NOW, TZ));
    expect(view.chart.points.map((point) => point.left)).toEqual([12, 10]);
    expect(view.chart.points.map((point) => point.date)).toEqual([daysAgo(1), daysAgo(0)]);
    expect(view.chart.idealFrom).toEqual(view.chart.points[0]);
    expect(view.chart.idealTo).toEqual({ date: '2026-10-31', left: 0 });
  });

  it('keeps a ten-day-old cost out of the burn window but inside the chart', () => {
    const view = ok(creditBurn(budgetOf([scaleway()]), usageOf([day(daysAgo(10), 90), day(daysAgo(0), 1)]), NOW, TZ));
    expect(view.burn?.recordedDays).toBe(1);
    expect(view.burn?.avgPerDay).toBe(1);
    expect(view.chart.points.map((point) => point.left)).toEqual([64, 63]);
  });

  it('lists the other budget rows with their own percentages', () => {
    const view = ok(creditBurn(budgetOf([claude, scaleway()]), usageOf(week(2)), NOW, TZ));
    expect(view.others.map((row) => row.id)).toEqual(['claude']);
    expect(view.others[0]?.percent).toBe(92);
    expect(view.others[0]?.value).toBe('92 % used');
  });
});
