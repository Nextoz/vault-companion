import { afterEach, describe, expect, it } from 'vitest';
import { clearReadTimings, parseServerMs, readTimings, recordRead, routeOf, speedRows } from './timings.ts';

afterEach(() => clearReadTimings());

describe('read timings (SP step 1)', () => {
  it('keeps only the route, never the query or fragment', () => {
    expect(routeOf('/api/tasks?known=abc,def')).toBe('/api/tasks');
    expect(routeOf('/api/notes#x')).toBe('/api/notes');
    recordRead('/api/tasks?known=abc', 10, null, 1);
    expect(JSON.stringify(readTimings())).not.toContain('abc');
  });

  it('reads the Worker time from Server-Timing, null when absent or malformed', () => {
    expect(parseServerMs('app;dur=412')).toBe(412);
    expect(parseServerMs('edge;dur=3, app;dur=7.6')).toBe(8);
    expect(parseServerMs('myapp;dur=9')).toBeNull();
    expect(parseServerMs(null)).toBeNull();
  });

  it('keeps a rolling window of the last 10 reads per route, newest first', () => {
    for (let i = 0; i < 12; i++) recordRead('/api/a', 100 + i, `app;dur=${i}`, i);
    const kept = readTimings();
    expect(kept).toHaveLength(10);
    expect(kept[0]).toEqual({ route: '/api/a', totalMs: 111, serverMs: 11, at: 11 });
    expect(kept.at(-1)!.at).toBe(2); // the two oldest reads rolled off
    expect(speedRows(kept)[0]).toMatchObject({ route: '/api/a', lastTotalMs: 111, count: 10 });
  });

  it('keeps at most 12 routes, newest route first', () => {
    for (let i = 0; i < 20; i++) recordRead(`/api/r${i}`, 1, null, 10 + i);
    const rows = speedRows(readTimings());
    expect(rows).toHaveLength(12);
    expect(rows[0]!.route).toBe('/api/r19');
    expect(rows.some((r) => r.route === '/api/r7')).toBe(false); // the oldest 8 routes were evicted
  });

  it('reports the last read and the median total for odd and even counts (even rounds)', () => {
    recordRead('/api/odd', 100, null, 1);
    recordRead('/api/odd', 200, null, 2);
    recordRead('/api/odd', 330, null, 3);
    expect(speedRows(readTimings())[0]).toMatchObject({ lastTotalMs: 330, medianTotalMs: 200, count: 3 });

    clearReadTimings();
    recordRead('/api/even', 100, null, 1);
    recordRead('/api/even', 103, null, 2);
    recordRead('/api/even', 101, null, 3);
    recordRead('/api/even', 102, null, 4);
    expect(speedRows(readTimings())[0]).toMatchObject({ lastTotalMs: 102, medianTotalMs: 102, count: 4 });
  });

  it('medians the Worker time over only the reads that carry one, null when none do', () => {
    recordRead('/api/mix', 10, null, 1);
    recordRead('/api/mix', 20, 'app;dur=40', 2);
    recordRead('/api/mix', 30, 'app;dur=60', 3);
    expect(speedRows(readTimings())[0]!.medianServerMs).toBe(50);

    clearReadTimings();
    recordRead('/api/none', 10, null, 1);
    recordRead('/api/none', 20, null, 2);
    expect(speedRows(readTimings())[0]!.medianServerMs).toBeNull();
  });
});
