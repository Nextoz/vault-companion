// Disposable real Git repositories for tests. Everything lives under the OS temp dir.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: ENV, encoding: 'utf8' }).trim();
}

export interface TempRepos {
  readonly root: string;
  readonly bare: string;
  /** Commit files as an external writer (desktop/another tool) straight onto the bare repo's main. */
  commitExternal(files: Record<string, string | Uint8Array | null>, message?: string): string;
  cleanup(): void;
}

export function createTempRepos(seed: Record<string, string | Uint8Array>): TempRepos {
  const root = mkdtempSync(join(tmpdir(), 'vc-git-'));
  const bare = join(root, 'remote.git');
  const work = join(root, 'writer');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, work);
  const apply = (files: Record<string, string | Uint8Array | null>) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(work, path);
      if (content === null) {
        rmSync(full, { force: true });
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  };
  apply(seed);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'push', '-q', 'origin', 'main');
  return {
    root,
    bare,
    commitExternal(files, message = 'external edit') {
      git(work, 'pull', '-q', '--ff-only');
      apply(files);
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', message);
      git(work, 'push', '-q', 'origin', 'main');
      return git(work, 'rev-parse', 'HEAD');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
