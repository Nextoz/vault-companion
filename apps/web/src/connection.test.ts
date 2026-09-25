import { describe, expect, it, vi } from 'vitest';
import type { Fetched } from './api.ts';
import { wake, type Connection } from './connection.ts';

function run(kind: Fetched<unknown>['kind']) {
  const calls: string[] = [];
  const connection: Connection[] = [];
  const deps = {
    session: vi.fn(async () => kind),
    kick: () => void calls.push('kick'),
    tasks: async () => void calls.push('tasks'),
    setConnection: (c: Connection) => void connection.push(c),
  };
  return { done: wake(deps), calls, connection };
}

describe('wake: every session outcome leads somewhere (P4-B)', () => {
  it('ok: kicks the queue and reads the tasks', async () => {
    const r = run('ok');
    await r.done;
    expect(r.calls).toEqual(['kick', 'tasks']);
    expect(r.connection).toEqual([]);
  });

  it('error (a 5xx, a malformed reply, or a read that timed out): the actionable error state, no task read', async () => {
    const r = run('error');
    await r.done;
    expect(r.connection).toEqual(['error']);
    expect(r.calls).toEqual([]);
  });

  it('offline: the offline state, which also offers Try again', async () => {
    const r = run('offline');
    await r.done;
    expect(r.connection).toEqual(['offline']);
    expect(r.calls).toEqual([]);
  });

  it('signed-out: nothing sent or read; the signed-out banner is set by the session read', async () => {
    const r = run('signed-out');
    await r.done;
    expect(r.connection).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});
