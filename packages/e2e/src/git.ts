// Git CLI helpers for the disposable end-to-end harness. Every repository the harness touches is configured by the
// harness itself; machine-level Git configuration (signing, hooks, negotiation settings) is shut out.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GitRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Environment that ignores the user's global and the system Git configuration. */
export function hermeticGitEnv(root: string): NodeJS.ProcessEnv {
  const empty = join(root, 'empty.gitconfig');
  writeFileSync(empty, '');
  return { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

export function tryGit(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): GitRun {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function git(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Set identity and line-ending policy on one repository (never global). */
export function configureRepo(env: NodeJS.ProcessEnv, repo: string, name: string, email: string): void {
  git(env, repo, 'config', 'user.name', name);
  git(env, repo, 'config', 'user.email', email);
  git(env, repo, 'config', 'core.autocrlf', 'false');
  git(env, repo, 'config', 'commit.gpgsign', 'false');
}

export interface RemoteFixture {
  readonly root: string;
  readonly bare: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A temp root with a bare repository whose `main` holds exactly `seed` (one commit). */
export function createRemote(seed: Readonly<Record<string, string>>): RemoteFixture {
  const root = mkdtempSync(join(tmpdir(), 'vc-e2e-'));
  try {
    return seedRemote(root, seed);
  } catch (e) {
    rmSync(root, { recursive: true, force: true }); // never leak a half-built fixture
    throw e;
  }
}

function seedRemote(root: string, seed: Readonly<Record<string, string>>): RemoteFixture {
  const env = hermeticGitEnv(root);
  const bare = join(root, 'remote.git');
  const seeder = join(root, 'seeder');
  git(env, root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(env, root, 'init', '-q', '-b', 'main', seeder);
  configureRepo(env, seeder, 'Seed', 'seed@example.invalid');
  for (const [path, text] of Object.entries(seed)) {
    const full = join(seeder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(env, seeder, 'add', '-A');
  git(env, seeder, 'commit', '-q', '-m', 'seed');
  git(env, seeder, 'push', '-q', bare, 'main');
  return { root, bare, env };
}

export interface LoggedCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly operationId: string;
}

/** First-parent-agnostic log of `ref` in `repo`, oldest first, with the Vault-Companion-Op trailer. */
export function logWithOps(env: NodeJS.ProcessEnv, repo: string, ref = 'main'): LoggedCommit[] {
  const out = git(env, repo, 'log', '--reverse', '-z', '--format=%H%x1f%P%x1f%s%x1f%(trailers:key=Vault-Companion-Op,valueonly)', ref);
  return out
    .split('\0')
    .filter((e) => e.trim().length > 0)
    .map((e) => {
      const [sha, parents, subject, op] = e.split('\x1f').map((s) => s.trim()) as [string, string, string, string];
      return { sha, parents: parents ? parents.split(' ') : [], subject, operationId: op };
    });
}
