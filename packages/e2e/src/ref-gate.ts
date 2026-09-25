// Harness-only coordination point around the real git processes of `LocalGitStore` (review P2A-Astra #1).
//
// When armed, the first two `commit-tree` runs (one per concurrent write) execute for real, but their results are held
// until BOTH have been prepared, so both commits are built on the same parent before either publishes. Then write #1 is
// released and runs its real `git update-ref`; only when that process has exited is write #2 released to run its own.
// Nothing is mocked: every git process runs unchanged and its real exit status reaches the store. The gate only orders
// completions, turning "two writes raced on one head" from a scheduling accident into a guaranteed event.
import type { execFile as ExecFile } from 'node:child_process';

export interface GatedWrite {
  /** `-p` argument of the held `commit-tree`: the base commit the write was computed against. */
  readonly parent: string;
  /** Exit status of this write's real `update-ref` (0 = published). */
  updateRefCode?: number;
}

type Callback = (error: (Error & { code?: unknown }) | null, stdout: unknown, stderr: unknown) => void;

interface Armed {
  readonly writes: GatedWrite[];
  readonly held: (() => void)[];
  /** Index of the write whose `update-ref` runs next (after its commit-tree result was released). */
  turn: number | null;
  readonly done: (writes: GatedWrite[]) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

let armed: Armed | null = null;

/** Arm the gate for the next two store writes. Resolves when both real `update-ref` runs have finished. */
export function armRefCollision(timeoutMs = 10_000): Promise<GatedWrite[]> {
  if (armed) throw new Error('ref gate already armed');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const a = armed;
      armed = null;
      a?.held.forEach((release) => release()); // never leave a request hanging
      reject(new Error(`ref gate: expected two concurrent writes, saw ${a?.writes.length ?? 0}`));
    }, timeoutMs);
    armed = { writes: [], held: [], turn: null, done: resolve, timer };
  });
}

/** Git subcommand after the leading `-C <dir>` / `-c <k=v>` options. */
function subcommand(args: readonly string[]): string | undefined {
  let i = 0;
  while (args[i] === '-C' || args[i] === '-c') i += 2;
  return args[i];
}

function release(a: Armed, index: number): void {
  a.turn = index;
  a.held[index]!();
}

/** Wrap `child_process.execFile`; installed with `vi.mock('node:child_process')` in the e2e test file. */
export function gateExecFile(real: typeof ExecFile): typeof ExecFile {
  const gated = (...params: unknown[]) => {
    const [file, args, options, callback] = params as [string, readonly string[], unknown, Callback];
    const a = armed;
    const call = (cb: Callback) => (real as unknown as (...p: unknown[]) => ReturnType<typeof ExecFile>)(file, args, options, cb);
    if (!a || file !== 'git' || !Array.isArray(args) || typeof callback !== 'function') {
      return (real as unknown as (...p: unknown[]) => ReturnType<typeof ExecFile>)(...params);
    }
    const sub = subcommand(args);
    if (sub === 'commit-tree' && a.writes.length < 2) {
      const index = a.writes.push({ parent: args[args.indexOf('-p') + 1]! }) - 1;
      return call((error, stdout, stderr) => {
        a.held[index] = () => callback(error, stdout, stderr);
        if (a.held.filter(Boolean).length === 2) release(a, 0);
      });
    }
    if (sub === 'update-ref' && a.turn !== null) {
      const index = a.turn;
      a.turn = null;
      return call((error, stdout, stderr) => {
        a.writes[index]!.updateRefCode = error ? Number(error.code ?? 1) : 0;
        callback(error, stdout, stderr);
        if (index === 0) {
          release(a, 1);
        } else {
          clearTimeout(a.timer);
          armed = null;
          a.done(a.writes);
        }
      });
    }
    return call(callback);
  };
  return gated as unknown as typeof ExecFile;
}
