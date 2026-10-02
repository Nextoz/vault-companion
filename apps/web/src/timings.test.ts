import { afterEach, describe, expect, it } from 'vitest';
import { clearReadTimings, parseServerMs, readTimings, recordRead, routeOf } from './timings.ts';

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

  it('keeps the latest read per route, newest first, at most 12 routes', () => {
    recordRead('/api/a', 100.4, 'app;dur=40', 1);
    recordRead('/api/b', 200, null, 2);
    recordRead('/api/a', 50, 'app;dur=20', 3);
    expect(readTimings()).toEqual([
      { route: '/api/a', totalMs: 50, serverMs: 20, at: 3 },
      { route: '/api/b', totalMs: 200, serverMs: null, at: 2 },
    ]);
    for (let i = 0; i < 20; i++) recordRead(`/api/r${i}`, 1, null, 10 + i);
    expect(readTimings()).toHaveLength(12);
    expect(readTimings()[0]!.route).toBe('/api/r19');
    expect(readTimings().some((t) => t.route === '/api/a')).toBe(false);
  });
});
