// In-memory VaultStore with Git-like semantics for domain tests.
// Semantics mirror the probed GitHub Git Data API path (ADR-0011): a write is a commit parented on the pinned
// commit and succeeds only if the branch head is still exactly that commit; trailers are searchable; blob SHAs are
// real Git blob SHAs. Checked against real Git by packages/github/src/store-contract.test.ts.
import {
  StoreUnavailable,
  StoreUnknownOutcome,
  TRAILER_OP,
  TRAILER_PAYLOAD,
  type FindOperationResult,
  type StoredFile,
  type VaultPath,
  type VaultStore,
  type WriteRequest,
  type WriteResult,
} from '../store.ts';
import { isStructurallySafePath } from '../paths.ts';

function guard(path: string): void {
  if (!isStructurallySafePath(path)) throw new StoreUnavailable('unsafe vault path rejected by adapter');
}

interface Commit {
  readonly sha: string;
  readonly parent: string | null;
  readonly tree: ReadonlyMap<string, string>; // path -> blob sha
  readonly trailers: Readonly<Record<string, string>>;
  readonly changed: readonly string[];
  readonly message: string;
}

/** What the next writeFile call does (queue; default 'normal'). */
export type WriteFault =
  | 'normal'
  /** Commit is applied, but the caller sees a lost response. */
  | 'apply-then-unknown'
  /** Commit is NOT applied, and the caller cannot tell (timeout before GitHub processed it). */
  | 'drop-then-unknown'
  | 'unavailable';

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class InMemoryStore implements VaultStore {
  private readonly commits = new Map<string, Commit>();
  private readonly blobs = new Map<string, Uint8Array>();
  private headSha: string;
  private counter = 0;
  readonly writeFaults: WriteFault[] = [];
  /** Runs after `head()` resolves, before the caller uses it (to land concurrent commits). */
  afterHead: (() => Promise<void>) | null = null;
  /** Max commits `findOperation` may inspect before answering `unknown` (compare truncation). */
  dedupeWindowLimit = 250;
  writeCalls = 0;

  private constructor(root: Commit) {
    this.commits.set(root.sha, root);
    this.headSha = root.sha;
  }

  static async create(files: Record<string, string | Uint8Array>): Promise<InMemoryStore> {
    const store = new InMemoryStore({ sha: '0'.repeat(40), parent: null, tree: new Map(), trailers: {}, changed: [], message: 'root' });
    await store.commitFiles(files, 'seed');
    return store;
  }

  /** Commit arbitrary changes as "the desktop" or "another tool" would (no CAS). `null` deletes. */
  async commitFiles(files: Record<string, string | Uint8Array | null>, message = 'external edit'): Promise<string> {
    const head = this.commits.get(this.headSha)!;
    const tree = new Map(head.tree);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) {
        tree.delete(path);
        continue;
      }
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const sha = await gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      tree.set(path, sha);
    }
    return this.pushCommit(tree, {}, Object.keys(files), message);
  }

  private pushCommit(tree: Map<string, string>, trailers: Record<string, string>, changed: string[], message: string): string {
    const sha = (++this.counter).toString(16).padStart(40, 'c');
    this.commits.set(sha, { sha, parent: this.headSha, tree, trailers, changed, message });
    this.headSha = sha;
    return sha;
  }

  // ---- inspection helpers for tests ----
  get headCommit(): string {
    return this.headSha;
  }
  text(path: string, at = this.headSha): string | null {
    const blob = this.commits.get(at)?.tree.get(path);
    return blob === undefined ? null : new TextDecoder('utf-8', { ignoreBOM: true }).decode(this.blobs.get(blob)!);
  }
  commitsWithOp(operationId: string): string[] {
    return [...this.commits.values()].filter((c) => c.trailers[TRAILER_OP] === operationId).map((c) => c.sha);
  }
  commitMessages(): string[] {
    return [...this.commits.values()].map((c) => c.message);
  }
  /** Simulate a history rewrite that drops the last `n` commits (violates sync requirement W1). */
  rewindHead(n: number): void {
    for (let i = 0; i < n; i++) this.headSha = this.commits.get(this.headSha)!.parent!;
  }

  // ---- VaultStore ----
  async head(): Promise<{ commitSha: string }> {
    const commitSha = this.headSha;
    if (this.afterHead) await this.afterHead();
    return { commitSha };
  }

  async readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    guard(path);
    const commit = this.commits.get(atCommit);
    if (!commit) throw new StoreUnavailable(`unknown commit ${atCommit}`);
    const blobSha = commit.tree.get(path);
    if (blobSha === undefined) return null;
    return { blobSha, bytes: this.blobs.get(blobSha)!, commitSha: atCommit };
  }

  async listDir(dir: string, atCommit: string): Promise<readonly string[]> {
    guard(dir);
    const commit = this.commits.get(atCommit);
    if (!commit) throw new StoreUnavailable(`unknown commit ${atCommit}`);
    const prefix = `${dir}/`;
    // All entry types: a nested path contributes its first segment as a directory name.
    const names = new Set<string>();
    for (const p of commit.tree.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!);
    return [...names];
  }

  async writeFile(req: WriteRequest): Promise<WriteResult> {
    guard(req.path);
    this.writeCalls++;
    const fault = this.writeFaults.shift() ?? 'normal';
    if (fault === 'unavailable') throw new StoreUnavailable('simulated outage');
    if (fault === 'drop-then-unknown') throw new StoreUnknownOutcome('simulated timeout (not applied)');
    // Hash BEFORE the check: from here to pushCommit there must be no `await`, so check-and-set is atomic
    // like GitHub's ref update. An await in between let two concurrent writers both pass the CAS.
    const blobSha = await gitBlobSha(req.bytes);
    // Head-CAS (ADR-0011): publish only as a fast-forward from the pinned commit.
    if (this.headSha !== req.baseCommit) return { ok: false, reason: 'head-moved' };
    const head = this.commits.get(this.headSha)!;
    // Precondition against the pinned tree (rerun Astra N1 / Opus N1): no file AND no directory for 'absent'.
    const isFile = head.tree.has(req.path);
    const isDir = [...head.tree.keys()].some((p) => p.startsWith(`${req.path}/`));
    if (req.expect === 'absent' ? isFile || isDir : !isFile) return { ok: false, reason: 'precondition-failed' };
    this.blobs.set(blobSha, req.bytes);
    const tree = new Map(head.tree);
    tree.set(req.path, blobSha);
    const commitSha = this.pushCommit(tree, { ...req.trailers }, [req.path], req.message);
    if (fault === 'apply-then-unknown') throw new StoreUnknownOutcome('simulated lost response (applied)');
    return { ok: true, commitSha, blobSha };
  }

  async findOperation(baseCommitSha: string, untilCommit: string, operationId: string, key: string = TRAILER_OP): Promise<FindOperationResult> {
    if (!this.commits.has(baseCommitSha)) return { kind: 'unknown', reason: 'base commit unknown' };
    let sha: string | null = untilCommit;
    let inspected = 0;
    while (sha !== null && sha !== baseCommitSha) {
      if (++inspected > this.dedupeWindowLimit) return { kind: 'unknown', reason: 'window truncated' };
      const c: Commit = this.commits.get(sha)!;
      if (c.trailers[key] === operationId) {
        return { kind: 'found', op: { commitSha: c.sha, payloadHash: c.trailers[TRAILER_PAYLOAD] ?? '', paths: c.changed } };
      }
      sha = c.parent;
    }
    if (sha === null) return { kind: 'unknown', reason: 'base is not an ancestor' };
    return { kind: 'not-found' };
  }

  async isAncestor(commit: string, head: string): Promise<boolean> {
    for (let sha: string | null = head; sha !== null; sha = this.commits.get(sha)?.parent ?? null) {
      if (sha === commit) return true;
    }
    return false;
  }

  async parentOf(commitSha: string): Promise<string> {
    const parent = this.commits.get(commitSha)?.parent;
    if (!parent) throw new StoreUnavailable(`no parent for ${commitSha}`);
    return parent;
  }
}
