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
  StoreUnavailable,
  TRAILER_OP,
  TRAILER_PAYLOAD,
  type FindOperationResult,
  type StoredFile,
  type VaultPath,
  type VaultStore,
  type WriteRequest,
  type WriteResult,
} from '@vault-companion/domain';

export interface LocalGitStoreOptions {
  readonly repo: string;
  readonly branch?: string;
  readonly dedupeWindowLimit?: number;
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
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: LocalGitStoreOptions) {
    this.repo = opts.repo;
    this.ref = `refs/heads/${opts.branch ?? 'main'}`;
    this.windowLimit = opts.dedupeWindowLimit ?? 250;
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
    const blobSha = await this.blobAt(atCommit, path);
    if (blobSha === null) return null;
    const bytes = await this.ok(['cat-file', 'blob', blobSha]);
    return { blobSha, bytes: new Uint8Array(bytes), commitSha: atCommit };
  }

  async listDir(dir: string, atCommit: string): Promise<readonly string[]> {
    const r = await this.run(['ls-tree', '-z', `${atCommit}:${dir}`]);
    if (r.code !== 0) return [];
    return r.stdout
      .toString('utf8')
      .split('\0')
      .filter((e) => e.length > 0)
      .map((e) => e.split('\t') as [string, string])
      .filter(([meta]) => meta.split(' ')[1] === 'blob')
      .map(([, name]) => name);
  }

  async writeFile(req: WriteRequest): Promise<WriteResult> {
    const blob = (await this.ok(['hash-object', '-w', '--stdin'], req.bytes)).toString('utf8').trim();
    const trailers = Object.entries(req.trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const message = `${req.message}\n\n${trailers}\n`;
    // Loop only on ref races where the file itself is unchanged (GitHub Contents semantics).
    for (let i = 0; i < 10; i++) {
      const head = (await this.head()).commitSha;
      const current = await this.blobAt(head, req.path);
      if (req.expectedBlobSha === null ? current !== null : current !== req.expectedBlobSha) {
        return { ok: false, reason: req.expectedBlobSha === null ? 'exists' : 'cas-mismatch' };
      }
      const indexFile = join(tmpdir(), `vc-index-${randomUUID()}`);
      const env = { GIT_INDEX_FILE: indexFile };
      try {
        await this.ok(['read-tree', head], undefined, env);
        await this.ok(['update-index', '--add', '--cacheinfo', `100644,${blob},${req.path}`], undefined, env);
        const tree = (await this.ok(['write-tree'], undefined, env)).toString('utf8').trim();
        const commit = (await this.ok(['commit-tree', tree, '-p', head, '-F', '-'], new TextEncoder().encode(message))).toString('utf8').trim();
        const upd = await this.run(['update-ref', this.ref, commit, head]);
        if (upd.code === 0) return { ok: true, commitSha: commit, blobSha: blob };
      } finally {
        await rm(indexFile, { force: true });
      }
    }
    throw new StoreUnavailable('ref kept moving');
  }

  async findOperation(baseCommitSha: string, untilCommit: string, operationId: string): Promise<FindOperationResult> {
    if ((await this.run(['cat-file', '-e', `${baseCommitSha}^{commit}`])).code !== 0) return { kind: 'unknown', reason: 'base commit unknown' };
    if ((await this.run(['merge-base', '--is-ancestor', baseCommitSha, untilCommit])).code !== 0) {
      return { kind: 'unknown', reason: 'base is not an ancestor' };
    }
    const out = await this.ok([
      'log',
      '-z',
      `--max-count=${this.windowLimit + 1}`,
      `--format=%H%x1f%(trailers:key=${TRAILER_OP},valueonly,separator=%x1e)%x1f%(trailers:key=${TRAILER_PAYLOAD},valueonly,separator=%x1e)`,
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

  async parentOf(commitSha: string): Promise<string> {
    return this.line(['rev-parse', '--verify', `${commitSha}^`]);
  }
}
