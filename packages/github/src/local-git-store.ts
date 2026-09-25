// VaultStore over a real Git repository (bare or not) using the git CLI. Node only.
// Used by the disposable end-to-end harness (Phase 2) and to keep InMemoryStore honest via the shared
// store contract tests. Mirrors the *assumed* GitHub Contents API semantics: CAS on the file's blob at
// the branch head; a new commit on top of the head; a moved head with an unchanged file still succeeds.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPARE_PAGE,
  StoreUnavailable,
  TRAILER_OP,
  TRAILER_PAYLOAD,
  type CommitInfo,
  type CommitsSinceResult,
  type FindOperationResult,
  type StoredFile,
  type VaultPath,
  type VaultStore,
  type WriteRequest,
  type WriteResult,
} from '@vault-companion/domain';
import { guardPath, parseTrailers } from './contents-store.ts';

export interface LocalGitStoreOptions {
  readonly repo: string;
  readonly branch?: string;
  readonly dedupeWindowLimit?: number;
  /** Max commits `commitsSince` lists before answering `too-many` (default one compare page, 250). */
  readonly comparePageSize?: number;
  readonly author?: { name: string; email: string };
}

interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export class LocalGitStore implements VaultStore {
  private readonly repo: string;
  private readonly ref: string;
  private readonly windowLimit: number;
  private readonly pageSize: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: LocalGitStoreOptions) {
    this.repo = opts.repo;
    this.ref = `refs/heads/${opts.branch ?? 'main'}`;
    this.windowLimit = opts.dedupeWindowLimit ?? 250;
    this.pageSize = opts.comparePageSize ?? COMPARE_PAGE;
    const who = opts.author ?? { name: 'Vault Companion', email: 'vault-companion@localhost' };
    this.env = {
      ...process.env,
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  private run(args: readonly string[], input?: Uint8Array, extraEnv?: NodeJS.ProcessEnv): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', this.repo, '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', ...args],
        { encoding: 'buffer', env: { ...this.env, ...extraEnv }, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            reject(new StoreUnavailable(`git failed to start: ${error.message}`));
            return;
          }
          resolve({ code: error ? ((error as { code: number }).code ?? 1) : 0, stdout, stderr: stderr.toString('utf8') });
        },
      );
      if (input) child.stdin!.end(Buffer.from(input));
      else child.stdin!.end();
    });
  }

  private async ok(args: readonly string[], input?: Uint8Array, extraEnv?: NodeJS.ProcessEnv): Promise<Buffer> {
    const r = await this.run(args, input, extraEnv);
    if (r.code !== 0) throw new StoreUnavailable(`git ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  private async line(args: readonly string[]): Promise<string> {
    return (await this.ok(args)).toString('utf8').trim();
  }

  private async blobAt(commit: string, path: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${commit}:${path}`]);
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }

  async head(): Promise<{ commitSha: string }> {
    return { commitSha: await this.line(['rev-parse', '--verify', this.ref]) };
  }

  async readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    guardPath(path);
    const blobSha = await this.blobAt(atCommit, path);
    if (blobSha === null) return null;
    const bytes = await this.ok(['cat-file', 'blob', blobSha]);
    return { blobSha, bytes: new Uint8Array(bytes), commitSha: atCommit };
  }

  async listDir(dir: string, atCommit: string): Promise<readonly string[]> {
    guardPath(dir);
    const r = await this.run(['ls-tree', '-z', `${atCommit}:${dir}`]);
    if (r.code !== 0) {
      // Fail closed (rerun Opus N1): `[]` only when the commit exists and the directory is provably absent.
      if ((await this.run(['cat-file', '-e', `${atCommit}^{commit}`])).code !== 0) throw new StoreUnavailable('unknown commit');
      if ((await this.run(['cat-file', '-e', `${atCommit}:${dir}`])).code === 0) throw new StoreUnavailable('directory listing failed');
      return [];
    }
    // All entry types (files, directories, links): any existing name is taken (rerun Astra N1).
    return r.stdout
      .toString('utf8')
      .split('\0')
      .filter((e) => e.length > 0)
      .map((e) => e.split('\t')[1]!);
  }

  /** Mode and type of the exact `path` entry in `commit`'s tree, or null when nothing is there. */
  private async entryAt(commit: string, path: string): Promise<{ mode: string; type: string } | null> {
    const r = await this.run(['ls-tree', '-z', commit, '--', path]);
    if (r.code !== 0) throw new StoreUnavailable('tree lookup failed');
    const hit = r.stdout
      .toString('utf8')
      .split('\0')
      .map((e) => e.split('\t'))
      .find(([, name]) => name === path);
    if (!hit) return null;
    const [mode, type] = hit[0]!.split(' ') as [string, string];
    return { mode, type };
  }

  async writeFile(req: WriteRequest): Promise<WriteResult> {
    guardPath(req.path);
    const blob = (await this.ok(['hash-object', '-w', '--stdin'], req.bytes)).toString('utf8').trim();
    const trailers = Object.entries(req.trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const message = `${req.message}\n\n${trailers}\n`;
    // Precondition against the pinned tree (rerun Astra N1 / Opus N1, N7).
    const entry = await this.entryAt(req.baseCommit, req.path);
    const satisfied = req.expect === 'absent' ? entry === null : entry?.type === 'blob' && entry.mode === '100644';
    if (!satisfied) return { ok: false, reason: 'precondition-failed' };
    // Head-CAS (ADR-0011): commit parented on the pinned base; `update-ref <new> <old>` refuses unless the branch is
    // still exactly at the base, atomically (same as GitHub's non-force ref update).
    const indexFile = join(tmpdir(), `vc-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.ok(['read-tree', req.baseCommit], undefined, env);
      await this.ok(['update-index', '--add', '--cacheinfo', `100644,${blob},${req.path}`], undefined, env);
      const tree = (await this.ok(['write-tree'], undefined, env)).toString('utf8').trim();
      const commit = (await this.ok(['commit-tree', tree, '-p', req.baseCommit, '-F', '-'], new TextEncoder().encode(message))).toString('utf8').trim();
      const upd = await this.run(['update-ref', this.ref, commit, req.baseCommit]);
      return upd.code === 0 ? { ok: true, commitSha: commit, blobSha: blob } : { ok: false, reason: 'head-moved' };
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  async findOperation(baseCommitSha: string, untilCommit: string, operationId: string, key: string = TRAILER_OP): Promise<FindOperationResult> {
    if ((await this.run(['cat-file', '-e', `${baseCommitSha}^{commit}`])).code !== 0) return { kind: 'unknown', reason: 'base commit unknown' };
    if ((await this.run(['merge-base', '--is-ancestor', baseCommitSha, untilCommit])).code !== 0) {
      return { kind: 'unknown', reason: 'base is not an ancestor' };
    }
    const out = await this.ok([
      'log',
      '-z',
      `--max-count=${this.windowLimit + 1}`,
      `--format=%H%x1f%(trailers:key=${key},valueonly,separator=%x1e)%x1f%(trailers:key=${TRAILER_PAYLOAD},valueonly,separator=%x1e)`,
      `${baseCommitSha}..${untilCommit}`,
    ]);
    const entries = out.toString('utf8').split('\0').filter((e) => e.trim().length > 0);
    for (const entry of entries.slice(0, this.windowLimit)) {
      const [sha, op, hash] = entry.split('\x1f').map((s) => s.trim()) as [string, string, string];
      if (op === operationId) {
        const paths = (await this.ok(['diff-tree', '--no-commit-id', '--name-only', '-z', '-r', sha]))
          .toString('utf8')
          .split('\0')
          .filter((p) => p.length > 0);
        return { kind: 'found', op: { commitSha: sha, payloadHash: hash, paths } };
      }
    }
    if (entries.length > this.windowLimit) return { kind: 'unknown', reason: 'window truncated' };
    return { kind: 'not-found' };
  }

  private async commitExists(sha: string): Promise<boolean> {
    return /^[0-9a-f]{40}$/.test(sha) && (await this.run(['cat-file', '-e', `${sha}^{commit}`])).code === 0;
  }

  async readCommit(commitSha: string): Promise<CommitInfo | null> {
    if (!(await this.commitExists(commitSha))) return null;
    const [parents, message] = (await this.ok(['log', '-1', '--format=%P%x1f%B', commitSha])).toString('utf8').split('\x1f') as [string, string];
    // Raw diff against the first parent: ":<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0".
    const raw = (await this.ok(['diff-tree', '-r', '--root', '--no-commit-id', '-z', '--raw', '--no-renames', commitSha])).toString('utf8').split('\0');
    const files: { path: string; blobSha: string | null }[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i]!.split(' ');
      const blob = meta[3]!;
      files.push({ path: raw[i + 1]!, blobSha: /^0+$/.test(blob) ? null : blob });
    }
    return { sha: commitSha, parent: parents.trim().split(' ').filter(Boolean)[0] ?? null, trailers: parseTrailers(message), files };
  }

  async commitsSince(base: string, until: string): Promise<CommitsSinceResult> {
    if (!(await this.commitExists(base)) || !(await this.commitExists(until))) return { kind: 'not-ancestor' };
    if ((await this.run(['merge-base', '--is-ancestor', base, until])).code !== 0) return { kind: 'not-ancestor' };
    const out = await this.ok(['log', '-z', `--max-count=${this.pageSize + 1}`, '--format=%H%x1f%B', `${base}..${until}`]);
    const entries = out.toString('utf8').split('\0').filter((e) => e.trim().length > 0);
    if (entries.length > this.pageSize) return { kind: 'too-many' };
    return {
      kind: 'ok',
      commits: entries.map((e) => {
        const [sha, message] = e.split('\x1f') as [string, string];
        return { sha: sha.trim(), trailers: parseTrailers(message) };
      }),
    };
  }

  async isAncestor(commit: string, head: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', commit, head])).code === 0;
  }

  async parentOf(commitSha: string): Promise<string> {
    return this.line(['rev-parse', '--verify', `${commitSha}^`]);
  }
}
