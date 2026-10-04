import { AiBudgetResponse, AiUsageResponse, type AiUsageDay } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { aiUsageDayValue, aiUsageFreshness, aiUsageMetric, aiUsageSpark, aiUsageTiles, formatAiUsageValue } from './ai-usage.ts';

const TZ = 'Europe/Copenhagen';
const REV = 'a'.repeat(40);
const now = Date.parse('2026-10-04T13:00:00+02:00');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysFrom = (first: string, count: number) => Array.from({ length: count }, (_, index) => iso(Date.parse(`${first}T00:00:00Z`) + index * DAY));

const day = (date: string, over: Partial<AiUsageDay> = {}): AiUsageDay => ({
  date, calls: 1, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, cost: 0, ...over,
});
const usage = (providers: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  AiUsageResponse.parse({ revision: REV, generatedAt: '2026-10-04T12:00:00+02:00', providers, skipped: 0, ...over });
const budget = AiBudgetResponse.parse({
  revision: REV, generatedAt: '2026-10-04T08:00:00+02:00', freeRamGb: null,
  providers: [
    { id: 'claude', label: 'Claude weekly', kind: 'percent', value: 92, limit: 100, unit: null, resetsAt: null, history: null },
    { id: 'scaleway', label: 'Scaleway credits', kind: 'money', value: 1.5, limit: null, unit: '\u20ac', resetsAt: null, history: null },
  ],
});
const tile = (id: string, providers: Record<string, unknown>, range: 7 | 30 = 7, withBudget: AiBudgetResponse | null = null) =>
  aiUsageTiles(usage(providers), withBudget, now, TZ, range).tiles.find((entry) => entry.id === id)!;

describe('aiUsageMetric and the daily value', () => {
  it('maps providers to tokens, calls or cost and defaults an unknown id to calls', () => {
    expect(aiUsageMetric('claude')).toBe('tokens');
    expect(aiUsageMetric('Claude-Code')).toBe('tokens');
    expect(aiUsageMetric('codex')).toBe('tokens');
    expect(aiUsageMetric('jev')).toBe('calls');
    expect(aiUsageMetric('deepseek')).toBe('cost');
    expect(aiUsageMetric('scaleway')).toBe('cost');
    expect(aiUsageMetric('mystery')).toBe('calls');
  });

  it('counts tokens as output + cache-write and never cache-read', () => {
    const row = day('2026-10-03', { calls: 4, outputTokens: 200, cacheWriteTokens: 10, cacheReadTokens: 5_000, cost: 1.5 });
    expect(aiUsageDayValue('tokens', row)).toBe(210);
    expect(aiUsageDayValue('calls', row)).toBe(4);
    expect(aiUsageDayValue('cost', row)).toBe(1.5);
  });
});

describe('aiUsageTiles slicing and honesty', () => {
  it('slices the last 7 or 30 day entries, oldest first', () => {
    const dates = daysFrom('2026-08-26', 40);
    const providers = { claude: { days: dates.map((date, index) => day(date, { outputTokens: index + 1 })) } };
    const seven = tile('claude', providers, 7);
    expect(seven.points.map((point) => point.date)).toEqual(dates.slice(-7));
    expect(seven.points.at(-1)!.value).toBe(40);
    const thirty = tile('claude', providers, 30);
    expect(thirty.points.map((point) => point.date)).toEqual(dates.slice(-30));
    expect(thirty.points).toHaveLength(30);
  });

  it('never zero-fills before the first data day and says when history starts', () => {
    const short = tile('claude', { claude: { label: 'Claude', days: [day('2026-09-08'), day('2026-09-10')] } });
    expect(short.windowStart).toBe('2026-09-04');
    expect(short.points.map((point) => point.date)).toEqual(['2026-09-08', '2026-09-10']);
    expect(short.note).toBe('Claude: history starts 8 Sep');
    const spark = aiUsageSpark(short, 160, 36, 3);
    expect(spark.segments).toHaveLength(0);
    expect(spark.dots).toHaveLength(2);
  });

  it('draws a full window with a joined line and no history note', () => {
    const dates = daysFrom('2026-09-28', 7);
    const full = tile('claude', { claude: { days: dates.map((date) => day(date, { outputTokens: 5 })) } });
    expect(full.points).toHaveLength(7);
    expect(full.note).toBeNull();
    expect(aiUsageSpark(full, 160, 36, 3).segments).toHaveLength(1);
  });

  it('keeps an unknown provider and titles it with its id', () => {
    const view = aiUsageTiles(usage({ mystery: { days: [day('2026-10-02', { calls: 7 })] } }), null, now, TZ, 7);
    expect(view.tiles).toHaveLength(1);
    expect(view.tiles[0]!.title).toBe('mystery');
    expect(view.tiles[0]!.metric).toBe('calls');
    expect(view.tiles[0]!.points[0]!.value).toBe(7);
  });

  it('has no numbers at all when the response is missing', () => {
    expect(aiUsageTiles(null, budget, now, TZ, 7)).toEqual({ tiles: [], freshness: null });
  });
});

describe('the budget "left" line', () => {
  it('reuses the budget row text and tone, and omits the line when there is no row', () => {
    const providers = { claude: { days: [day('2026-10-03')] }, scaleway: { days: [day('2026-10-03')] }, jev: { days: [day('2026-10-03')] } };
    const view = aiUsageTiles(usage(providers), budget, now, TZ, 7);
    const claude = view.tiles.find((entry) => entry.id === 'claude')!;
    expect(claude.left).toBe('92 % used');
    expect(claude.leftTone).toBe('bad');
    const scaleway = view.tiles.find((entry) => entry.id === 'scaleway')!;
    expect(scaleway.left).toBe('\u20ac1.50 left');
    expect(scaleway.leftTone).toBe('bad');
    const jev = view.tiles.find((entry) => entry.id === 'jev')!;
    expect(jev.left).toBeNull();
    expect(jev.leftTone).toBeNull();
  });
});

describe('freshness and value formatting', () => {
  it('says Updated HH:MM, and says stale past two hours', () => {
    expect(aiUsageFreshness(usage({}, { generatedAt: '2026-10-04T12:30:00+02:00' }), now, TZ)).toEqual({ text: 'Updated 12:30', stale: false });
    const old = aiUsageFreshness(usage({}, { generatedAt: '2026-10-04T09:00:00+02:00' }), now, TZ)!;
    expect(old.stale).toBe(true);
    expect(old.text).toContain('stale (> 2 h)');
    expect(aiUsageFreshness(null, now, TZ)).toBeNull();
  });

  it('formats tokens/calls as integers and cost with its currency', () => {
    expect(formatAiUsageValue('tokens', null, 1_234)).toBe('1,234');
    expect(formatAiUsageValue('calls', null, 7)).toBe('7');
    expect(formatAiUsageValue('cost', 'EUR', 1.5)).toBe('\u20ac1.50');
    expect(formatAiUsageValue('cost', 'DKK', 1.5)).toBe('DKK\u00a01.50');
    expect(formatAiUsageValue('cost', null, 1.5)).toBe('1.50');
  });
});
