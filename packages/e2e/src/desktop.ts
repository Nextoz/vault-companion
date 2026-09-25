// Desktop working copy + `desktopSync()`.
//
// THIS IS A MODEL OF THE CONTRACT, NOT THE REAL WINDOWS WORKER. It implements the requirements the app relies on
// (docs/sync.md W1–W5) with plain git so the Phase 2 harness can prove the app's side of the round trip. The real
// worker (`VaultGitSync.psm1`, owned in the vault) must still be verified at the Phase 3 canary gate.
//
//   W1  never rewrites or force-pushes published history: merge only (no rebase, no reset), plain `git push`.
//   W2  commits local edits before integrating remote changes, so "local changes would be overwritten" cannot block.
//   W3  integrates compatible divergence with a three-way merge.
//   W4  on a textual conflict preserves both versions: the merge is committed WITH conflict markers (the explicit
//       "markers committed" representation of docs/sync.md) and pushed, and the conflict is reported. The app then
//       refuses writes to that file (`refused:vault-conflict`) until the owner resolves it. Nothing is discarded.
//   W5  there is no Google Drive in this model, so Drive availability cannot affect it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configureRepo, git, tryGit } from './git.ts';

export interface SyncReport {
  /** A commit was made from uncommitted working-copy edits (W2). */
  readonly committedLocal: boolean;
  readonly integrated: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict';
  /** Files committed with conflict markers (W4). Empty unless `integrated === 'conflict'`. */
  readonly conflicts: readonly string[];
  readonly pushed: boolean;
  /** Plain pushes the remote rejected because it moved after this run fetched (then re-integrated, W1/W3). */
  readonly pushRejections: number;
}

export interface SyncHooks {
  /**
   * Harness-only coordination point: runs synchronously right before each push attempt (`round` starts at 1), after
   * fetch/merge. Tests use it to let a real second writer advance the remote in exactly that window.
   */
  readonly beforePush?: (round: number) => void;
}

const MAX_PUSH_ROUNDS = 3;

export class Desktop {
  private constructor(
    readonly dir: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  static clone(env: NodeJS.ProcessEnv, bare: string, dir: string): Desktop {
    git(env, dirname(dir), 'clone', '-q', '-b', 'main', bare, dir);
    configureRepo(env, dir, 'Desktop', 'desktop@example.invalid');
    // Deterministic, standard two-way markers (no diff3 base section).
    git(env, dir, 'config', 'merge.conflictStyle', 'merge');
    return new Desktop(dir, env);
  }

  read(path: string): string {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(join(this.dir, path)));
  }

  write(path: string, text: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), text);
  }

  /** An Obsidian-style edit of the working copy (not committed). */
  edit(path: string, change: (text: string) => string): void {
    const before = this.read(path);
    const after = change(before);
    if (after === before) throw new Error('edit changed nothing (test bug)');
    this.write(path, after);
  }

  /** Commit working-copy edits locally without integrating or pushing. */
  commit(message: string): string {
    git(this.env, this.dir, 'add', '-A');
    git(this.env, this.dir, 'commit', '-q', '-m', message);
    return this.head();
  }

  head(): string {
    return git(this.env, this.dir, 'rev-parse', 'HEAD');
  }

  git(...args: string[]): string {
    return git(this.env, this.dir, ...args);
  }

  /** One sync run: commit local → fetch → merge (conflicts preserved) → push. See header for W1–W5. */
  sync(hooks: SyncHooks = {}): SyncReport {
    const g = (...args: string[]) => git(this.env, this.dir, ...args);
    // W2: commit first.
    g('add', '-A');
    const dirty = tryGit(this.env, this.dir, 'diff', '--cached', '--quiet').code !== 0;
    if (dirty) g('commit', '-q', '-m', 'desktop: local edits');

    let integrated: SyncReport['integrated'] = 'up-to-date';
    let conflicts: string[] = [];
    let pushRejections = 0;
    for (let round = 1; round <= MAX_PUSH_ROUNDS; round++) {
      g('fetch', '-q', 'origin', 'main');
      const remote = g('rev-parse', 'origin/main');
      const head = g('rev-parse', 'HEAD');
      const remoteIncluded = tryGit(this.env, this.dir, 'merge-base', '--is-ancestor', remote, head).code === 0;
      if (!remoteIncluded) {
        const fastForward = tryGit(this.env, this.dir, 'merge-base', '--is-ancestor', head, remote).code === 0;
        // W1/W3: three-way merge, never rebase.
        const merge = tryGit(this.env, this.dir, 'merge', '--no-edit', '-q', 'origin/main');
        if (merge.code === 0) {
          if (integrated !== 'conflict') integrated = fastForward ? 'fast-forward' : 'merged';
        } else {
          conflicts = g('diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter((p) => p.length > 0);
          if (conflicts.length === 0) throw new Error(`merge failed without a textual conflict: ${merge.stderr.trim()}`);
          // W4: keep both sides — the markers are the record — and surface the conflict.
          g('add', '--', ...conflicts);
          g('commit', '-q', '--no-edit', '-m', `desktop: merge with ${conflicts.length} conflicted file(s) preserved`);
          integrated = 'conflict';
        }
      }
      if (g('rev-parse', 'HEAD') === remote) return { committedLocal: dirty, integrated, conflicts, pushed: false, pushRejections };
      // W1: plain push (fast-forward only). A concurrent app commit rejects it; integrate again.
      hooks.beforePush?.(round);
      if (tryGit(this.env, this.dir, 'push', '-q', 'origin', 'HEAD:main').code === 0) {
        return { committedLocal: dirty, integrated, conflicts, pushed: true, pushRejections };
      }
      pushRejections++;
    }
    throw new Error('desktop sync could not publish after repeated remote races');
  }
}
