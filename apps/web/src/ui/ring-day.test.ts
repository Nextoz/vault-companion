import { describe, expect, it, vi } from 'vitest';
import { getRingDay } from '../api.ts';
import { groupStrips, hourTicks, lineSegments, metricValue, slotX, STRIP_ORDER } from './ring-day.ts';

const metrics = groupStrips().flatMap(s => s.metrics);
const metric = (key: string) => metrics.find(m => m.key === key)!;
const slot = (minute: number, values: Record<string, number | null>) => ({ start: new Date(Date.parse('2026-10-20T00:00:00Z') + minute * 60_000).toISOString(), values });
describe('ring layout', () => {
  it('requests the encoded ring date and validates the response contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      expect((await getRingDay('2026-10-20&other=1')).kind).toBe('error');
      expect(fetcher.mock.calls[0]?.[0]).toBe('/api/health/ring?date=2026-10-20%26other%3D1');
    } finally { vi.unstubAllGlobals(); }
  });
  it('positions repeated 01 on a 25 hour axis and labels both local hours', () => {
    const a = '2026-11-01T00:00:00-04:00', b = '2026-11-02T00:00:00-05:00';
    expect(slotX('2026-11-01T01:00:00-05:00', a, b)).toBe(2 / 25);
    expect(slotX('2026-11-01T01:00:00-04:00', a, b)).toBe(1 / 25);
    const ticks = hourTicks(a, b, 'America/New_York');
    expect(ticks).toHaveLength(26); expect(ticks.slice(0, 4).map(t => t.label)).toEqual(['00', '01', '01', '02']);
    expect(ticks.at(-1)).toEqual({ x: 1, label: '24' });
  });
  it('uses a 23 hour axis and skips the missing local hour', () => {
    const a = '2026-03-29T00:00:00+01:00', b = '2026-03-30T00:00:00+02:00';
    expect(slotX('2026-03-29T03:00:00+02:00', a, b)).toBe(2 / 23);
    const ticks = hourTicks(a, b); expect(ticks).toHaveLength(24);
    expect(ticks.slice(0, 3).map(t => t.label)).toEqual(['00', '01', '03']);
  });
  it.each(['hr', 'hrMin', 'hrMax', 'steps'])('%s joins only adjacent elapsed slots, including absent rows', key => {
    expect(lineSegments([slot(0, { [key]: 5 }), slot(15, { [key]: 6 }), slot(45, { [key]: 7 }), slot(90, { [key]: 8 })], metric(key)).map(s => s.length)).toEqual([2, 1, 1]);
  });
  it.each(metrics.filter(m => m.strip !== 'hr' && m.chart !== 'bars').map(m => m.key))('%s joins two slots apart but breaks at three', key => {
    expect(lineSegments([slot(0, { [key]: 5 }), slot(30, { [key]: 6 }), slot(75, { [key]: 7 })], metric(key)).map(s => s.length)).toEqual([2, 1]);
  });
  it('omits null and absent values while retaining real zero', () => {
    expect(lineSegments([slot(0, { tempC: null }), slot(15, {}), slot(30, { tempC: 0 })], metric('tempC'))).toEqual([[{ start: slot(30, {}).start, value: 0 }]]);
    expect(metricValue(null, metric('tempC'))).toBe('—'); expect(metricValue(0, metric('steps'))).toBe('0');
  });
  it('orders strips as design A and preserves all metrics and unknown strips in registry order', () => {
    expect(groupStrips().map(s => s.name)).toEqual(STRIP_ORDER);
    const extra = [{ ...metrics[0]!, strip: 'future-b' }, { ...metrics[1]!, strip: 'future-a' }];
    const groups = groupStrips([...extra, ...metrics]);
    expect(groups.map(s => s.name)).toEqual([...STRIP_ORDER, 'future-b', 'future-a']);
    expect(groups.flatMap(s => s.metrics)).toHaveLength(metrics.length + 2);
  });
});
