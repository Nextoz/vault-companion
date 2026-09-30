import { describe, it, expect } from 'vitest';
import {
  diff,
  newBranches,
  completedCi,
  holdRemoved,
  activity,
  ownerActivity,
  readyBacklogChanged,
  newHandoffs,
  logFinished,
  buildWakeLine,
  parsePages,
  runOnce,
  sendWake,
  main,
} from './worker-watcher.mjs';

const START = '2026-09-30T00:00:00.000Z';
const LATER = '2026-09-30T01:00:00.000Z';

function fakeApi(overrides: Record<string, unknown> = {}) {
  const api: Record<string, unknown> = {
    branches: async () => ['origin/agent/a'],
    ciDone: async () => ['1:abc123'],
    prs: async () => [{ number: 1, labels: ['hold'] }],
    comments: async (n: number) => (n === 1
      ? [{ id: 'c1', user: { login: 'coderabbitai[bot]' }, updated_at: LATER, body: 'review done' }]
      : []),
    reviews: async () => [],
    readyBacklogMtime: async () => 1000,
    handoffs: async () => [],
    logs: async () => [],
    ...overrides,
  };
  return api as {
    branches: () => Promise<string[]>;
    ciDone: () => Promise<string[]>;
    prs: () => Promise<Array<{ number: number; labels: string[] }>>;
    comments: (n: number) => Promise<unknown[]>;
    reviews: (n: number) => Promise<unknown[]>;
    readyBacklogMtime: () => Promise<number | null>;
    handoffs: () => Promise<string[]>;
    logs: () => Promise<Array<{ path: string; mtimeIso: string; finished: boolean }>>;
  };
}

describe('watcher pure detection', () => {
  it('diffs branches and CI', () => {
    expect(diff(['a'], ['a', 'b'])).toEqual(['b']);
    expect(newBranches([], ['origin/agent/x'])).toEqual(['origin/agent/x']);
    expect(completedCi([], ['2:def'])).toEqual(['2:def']);
  });

  it('detects hold-label removal only', () => {
    const before = [{ number: 1, labels: ['hold'] }, { number: 2, labels: ['hold'] }];
    const after = [{ number: 1, labels: ['hold'] }, { number: 2, labels: [] }];
    expect(holdRemoved(before, after)).toEqual([2]);
  });

  it('separates CodeRabbit bots from the human owner and skips bot placeholders', () => {
    const comments = [
      { id: 'bot1', user: { login: 'coderabbitai[bot]' }, updated_at: LATER, body: 'Currently processing the diff' },
      { id: 'bot2', user: { login: 'coderabbitai[bot]' }, updated_at: LATER, body: 'real finding' },
      { id: 'owner1', user: { login: 'Nextoz' }, updated_at: LATER, body: 'please fix' },
    ];
    expect(activity(comments, [], START, { bot: true })).toEqual(['bot2']);
    expect(ownerActivity(comments, [], START)).toEqual(['owner1']);
    expect(ownerActivity([], [{ id: 'r1', user: { login: 'some-bot' }, submitted_at: LATER, body: '' }], START)).toEqual([]);
  });

  it('preserves stable numeric API IDs for activity dedupe', () => {
    const comments = [
      { id: 123, user: { login: 'coderabbitai[bot]' }, updated_at: LATER, body: 'finding' },
      { id: 456, user: { login: 'Nextoz' }, updated_at: LATER, body: 'please fix' },
    ];
    expect(activity(comments, [], START, { bot: true })).toEqual(['123']);
    expect(ownerActivity(comments, [], START)).toEqual(['456']);
  });

  it('merges paginated gh api page arrays', () => {
    expect(parsePages('[{"id":1}]\n[{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(parsePages('[{"id":3}][{"id":4}]')).toEqual([{ id: 3 }, { id: 4 }]);
    expect(parsePages('')).toEqual([]);
  });

  it('watches Ready Backlog mtime without reading content', () => {
    expect(readyBacklogChanged(undefined, 1000)).toBe(false);
    expect(readyBacklogChanged(1000, 2000)).toBe(true);
    expect(readyBacklogChanged(1000, null)).toBe(false);
  });

  it('detects new handoffs and finished logs', () => {
    expect(newHandoffs(['a.md'], ['a.md', 'b.md'])).toEqual(['b.md']);
    const known = new Set(['old.log']);
    const logs = [
      { path: 'old.log', mtimeIso: LATER, finished: true },
      { path: 'new.log', mtimeIso: LATER, finished: true },
      { path: 'stale.log', mtimeIso: START, finished: true },
    ];
    expect(logFinished(logs, START, known).map(log => log.path)).toEqual(['new.log']);
  });

  it('builds sanitized WAKE metadata only', () => {
    const line = buildWakeLine([
      { kind: 'branch', value: 'agent/x' },
      { kind: 'owner', value: '7' },
    ]);
    expect(line).toBe('WAKE: NEW BRANCH agent/x; OWNER ACTIVITY PR #7');
    const noisy = buildWakeLine([{ kind: 'branch', value: 'agent/x\nnewline' }]);
    expect(noisy).not.toContain('\n');
    const capped = buildWakeLine([{ kind: 'branch', value: 'x'.repeat(200) }]);
    expect(capped.length).toBeLessThan(150);
  });
});

describe('runOnce with fake APIs', () => {
  it('reports every signal kind in one pass', async () => {
    const api = fakeApi({
      branches: async () => ['origin/agent/a'],
      ciDone: async () => ['1:abc123'],
      prs: async () => [{ number: 1, labels: [] }],
      readyBacklogMtime: async () => 2000,
      handoffs: async () => ['C:/dev/clone/.agent/handoffs/h2.md'],
      logs: async () => [{ path: 'C:/dev/run.log', mtimeIso: LATER, finished: true }],
    });
    const state: Record<string, unknown> = {
      startIso: START,
      seen: new Set(),
      finishedLogs: new Set(),
      branches: [],
      ci: [],
      prs: [{ number: 1, labels: ['hold'] }],
      readyMtime: 1000,
      handoffs: [],
    };
    const events = await runOnce(api as never, state as never);
    const kinds = events.map(event => event.kind).sort();
    expect(kinds).toEqual(['branch', 'ci', 'coderabbit', 'handoff', 'hold-removed', 'log', 'ready']);
  });

  it('deduplicates on a no-change second pass', async () => {
    const api = fakeApi();
    const state: Record<string, unknown> = { startIso: START, seen: new Set(), finishedLogs: new Set() };
    await runOnce(api as never, state as never);
    const second = await runOnce(api as never, state as never);
    expect(second).toEqual([]);
  });

  it('preserves prior state when APIs fail instead of inventing empty signals', async () => {
    const api = {
      branches: async () => { throw new Error('boom'); },
      ciDone: async () => { throw new Error('boom'); },
      prs: async () => { throw new Error('boom'); },
      comments: async () => { throw new Error('boom'); },
      reviews: async () => { throw new Error('boom'); },
      readyBacklogMtime: async () => { throw new Error('boom'); },
      handoffs: async () => { throw new Error('boom'); },
      logs: async () => { throw new Error('boom'); },
    };
    const state: Record<string, unknown> = {
      startIso: START,
      seen: new Set(),
      finishedLogs: new Set(),
      branches: ['origin/agent/keep'],
      ci: ['1:keep'],
      prs: [{ number: 1, labels: ['hold'] }],
      readyMtime: 1000,
      handoffs: ['keep.md'],
    };
    const events = await runOnce(api as never, state as never);
    expect(events).toEqual([]);
    expect(state.branches).toEqual(['origin/agent/keep']);
    expect(state.prs).toEqual([{ number: 1, labels: ['hold'] }]);
    expect(state.readyMtime).toBe(1000);
  });
});

describe('wake delivery', () => {
  it('submits WAKE to the explicit Lead agent and never focuses', async () => {
    const calls: string[][] = [];
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ''; };
    const result = await sendWake('w5:p2', 'WAKE: NEW BRANCH agent/x', runner);
    expect(result.sent).toBe(true);
    expect(calls[0]).toEqual(['herdr', 'agent', 'prompt', 'w5:p2', 'WAKE: NEW BRANCH agent/x', '--wait', '--timeout', '120000']);
    expect(calls[0]!.join(' ')).not.toContain('focus');
  });

  it('does not send without an explicit lead id', async () => {
    const calls: string[][] = [];
    const result = await sendWake('', 'WAKE: x', async (cmd, args) => { calls.push([cmd, ...args]); return ''; });
    expect(result.sent).toBe(false);
    expect(calls).toEqual([]);
  });

  it('retries delivery and reports all failures', async () => {
    const calls: string[][] = [];
    const result = await sendWake('lead', 'WAKE: x', async (cmd, args) => { calls.push([cmd, ...args]); throw new Error('down'); });
    expect(result.sent).toBe(false);
    expect(result.attempts).toBe(3);
    expect(calls.length).toBe(3);
  });
});

describe('watcher main loop', () => {
  it('wakes once on a new signal and exits 0', async () => {
    let polls = 0;
    const api = fakeApi({
      branches: async () => (polls++ === 0 ? [] : ['origin/agent/new']),
      ciDone: async () => [],
      prs: async () => [],
      comments: async () => [],
      reviews: async () => [],
      readyBacklogMtime: async () => null,
      handoffs: async () => [],
      logs: async () => [],
    });
    const calls: string[][] = [];
    const lines: string[] = [];
    const code = await main(['0.001', '1'], { HERDR_LEAD_PANE: 'w5:p2' }, {
      api,
      runner: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ''; },
      writeStdout: (line: string) => lines.push(line),
      writeStderr: () => {},
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe('herdr');
    expect(calls[0]![1]).toBe('agent');
    expect(calls[0]![2]).toBe('prompt');
    expect(calls[0]![3]).toBe('w5:p2');
    expect(calls[0]![4]).toBe('WAKE: NEW BRANCH origin/agent/new');
  });

  it('exits nonzero when wake delivery fails and never claims success', async () => {
    let polls = 0;
    const api = fakeApi({
      branches: async () => (polls++ === 0 ? [] : ['origin/agent/new']),
      ciDone: async () => [],
      prs: async () => [],
      comments: async () => [],
      reviews: async () => [],
      readyBacklogMtime: async () => null,
      handoffs: async () => [],
      logs: async () => [],
    });
    const calls: string[][] = [];
    const errs: string[] = [];
    const code = await main(['0.001', '1'], { HERDR_LEAD_PANE: 'w5:p2' }, {
      api,
      runner: async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); throw new Error('down'); },
      writeStdout: () => {},
      writeStderr: (line: string) => errs.push(line),
      sleep: async () => {},
    });
    expect(code).toBe(1);
    expect(calls.length).toBe(3);
    expect(errs.join('\n')).toContain('delivery failed');
  });
});
