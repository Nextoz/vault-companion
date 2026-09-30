// VaultStore over the GitHub REST API (Contents, Git refs/commits, Compare). Runs on Workers (fetch only).
// Response shapes and write/conflict semantics were probed against the real API (Phase 0 and gate G1):
// docs/discovery/phase-0-findings.md, docs/discovery/github-api-probe-2026-09-24.md.
import {
  assertDistinctFiles,
  COMPARE_PAGE,
  FileTooLarge,
  isStructurallySafePath,
  StoreUnavailable,
  StoreUnknownOutcome,
  TRAILER_OP,
  TRAILER_PAYLOAD,
  type CommitInfo,
  type CommitsSinceResult,
  type FindOperationResult,
  type ListedFile,
  type MultiWriteRequest,
  type MultiWriteResult,
  type StoredFile,
  type VaultPath,
  type VaultStore,
  type WriteRequest,
  type WriteResult,
} from '@vault-companion/domain';

export interface GitHubStoreOptions {
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  /** Returns a current installation token (see github-app-token.ts). Never logged. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  /** Max compare pages of 250 commits searched before dedupe answers `unknown` (default 20). */
  readonly maxComparePages?: number;
}

const MAX_CONTENT_BYTES = 1024 * 1024;
/** Longest standard base64 string that can still decode to `MAX_CONTENT_BYTES` bytes. */
const MAX_BASE64_BYTES = Math.ceil(MAX_CONTENT_BYTES / 3) * 4;
/** Entries kept per in-memory cache (keys are immutable commit SHAs; a full cache is simply dropped). */
const CACHE_LIMIT = 256;
/** Read-cache bounds: at most this many settled files and this many resident decoded bytes per store instance. */
const READ_CACHE_ENTRY_LIMIT = 128;
const READ_CACHE_BYTES_LIMIT = 8 * 1024 * 1024;
/** Concurrent identical immutable reads are single-flighted while this many distinct reads are already in flight. */
const READ_PENDING_LIMIT = 32;
const IMMUTABLE_COMMIT = /^[0-9a-f]{40}$/;

interface CachedFile {
  readonly blobSha: string;
  readonly bytes: Uint8Array;
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

export class GitHubContentsStore implements VaultStore {
  private readonly branch: string;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly maxPages: number;
  /** Commit → tree SHA seen in commit/compare responses, so a write on that commit skips re-reading it (ADR-0013). */
  private readonly trees = new Map<string, string>();
  /**
   * Directory listings per (commit, dir): a commit's tree never changes, so planning's listing also serves the write's
   * precondition on the same commit (ADR-0015: CaptureNote with an absent Inbox no longer pays for both). Only settled
   * answers are kept (entries, or confirmed absence); failures always throw afresh.
   */
  private readonly listings = new Map<string, TreeEntry[] | null>();
  /**
   * Settled Contents reads for immutable (commit SHA, path) keys. Bytes are stored as a private copy; callers always
   * receive another copy, so mutating a returned array cannot affect the cache or any other caller. Bounded by entry
   * count and decoded-byte budget; oldest-first eviction.
   */
  private readonly readCache = new Map<string, CachedFile>();
  private readCacheBytes = 0;
  /** Single-flight promises for identical immutable reads currently in progress; removed once settled. */
  private readonly pendingReads = new Map<string, Promise<StoredFile | null>>();

  constructor(private readonly opts: GitHubStoreOptions) {
    this.branch = opts.branch ?? 'main';
    // Bound: Workers throw "Illegal invocation" when the global fetch is called as a method of another object.
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = `${opts.apiBase ?? 'https://api.github.com'}/repos/${opts.owner}/${opts.repo}`;
    this.maxPages = opts.maxComparePages ?? 20;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.opts.token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vault-companion',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await this.f(`${this.base}${path}`, init);
    } catch (err) {
      // A GET that never completed had no effect; a PUT that never completed may have.
      if (method === 'GET') throw new StoreUnavailable(`network error on GET`);
      throw new StoreUnknownOutcome(`network error on ${method}: ${(err as Error).name}`);
    }
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const res = await this.call('GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new StoreUnavailable(`GitHub GET status ${res.status}`);
    return (await res.json()) as T;
  }

  private contentsPath(path: string): string {
    return `/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async commitMeta(commitSha: string) {
    const commit = await this.getJson<{ committer: { date: string }; message: string }>(`/git/commits/${commitSha}`);
    if (!commit) return null;
    return { committedAt: commit.committer.date, fromApp: TRAILER_OP in parseTrailers(commit.message) };
  }

  async head(): Promise<{ commitSha: string }> {
    const ref = await this.getJson<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!ref) throw new StoreUnavailable('branch not found');
    return { commitSha: ref.object.sha };
  }

  async readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    // Path safety precedes any cache lookup: a caller can never make the cache leak bytes for an unsafe path.
    guardPath(path);
    const immutable = IMMUTABLE_COMMIT.test(atCommit);
    const key = `${atCommit}\0${path}`;
    if (immutable) {
      const cached = this.readCache.get(key);
      if (cached) return copyStored(cached, atCommit);
    }
    if (immutable && this.pendingReads.has(key)) {
      const file = await this.pendingReads.get(key)!;
      return file ? copyStored(file, atCommit) : null;
    }
    // Non-SHA refs are never cached or single-flighted; a full in-flight table falls back to an uncached read.
    if (!immutable || this.pendingReads.size >= READ_PENDING_LIMIT) {
      const file = await this.fetchRead(path, atCommit);
      if (immutable && file) this.storeRead(key, file);
      return file;
    }
    // Identical immutable reads share one fetch; each caller still receives its own byte copy after settlement.
    let flight = this.pendingReads.get(key);
    if (!flight) {
      flight = this.fetchAndCacheRead(key, path, atCommit).finally(() => this.pendingReads.delete(key));
      this.pendingReads.set(key, flight);
    }
    const file = await flight;
    return file ? copyStored(file, atCommit) : null;
  }

  private async fetchAndCacheRead(key: string, path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    const file = await this.fetchRead(path, atCommit);
    if (file) this.storeRead(key, file);
    return file;
  }

  private async fetchRead(path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    const item = await this.getJson<{ type?: unknown; sha?: unknown; size?: unknown; content?: unknown; encoding?: unknown }>(
      `${this.contentsPath(path)}?ref=${atCommit}`,
    );
    if (!item) return null;
    if (typeof item.type !== 'string') throw new StoreUnavailable('malformed Contents type');
    if (item.type === 'dir' || item.type === 'symlink' || item.type === 'submodule') return null;
    if (item.type !== 'file') throw new StoreUnavailable('malformed Contents type');
    const { sha, size, encoding, content } = item;
    if (typeof sha !== 'string' || !IMMUTABLE_COMMIT.test(sha)) throw new StoreUnavailable('malformed Contents blob SHA');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new StoreUnavailable('malformed Contents size');
    if (size > MAX_CONTENT_BYTES) throw new FileTooLarge('file exceeds 1 MB');
    if (encoding !== 'base64') throw new StoreUnavailable('malformed Contents encoding');
    if (typeof content !== 'string') throw new StoreUnavailable('malformed Contents content');
    // Reject a dishonest oversized encoded payload before decoding/allocating its bytes. The real API only adds a
    // newline every 60 base64 characters, so that is the only whitespace allowance kept beyond the byte bound.
    if (content.length > MAX_BASE64_BYTES + Math.ceil(MAX_BASE64_BYTES / 60) + 1) throw new FileTooLarge('file exceeds 1 MB');
    // Phase 0: base64 arrives with embedded '\n' every 60 chars.
    const compact = content.replace(/\s/g, '');
    if (compact.length > MAX_BASE64_BYTES) throw new FileTooLarge('file exceeds 1 MB');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
      throw new StoreUnavailable('malformed Contents base64');
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(compact);
    } catch {
      throw new StoreUnavailable('malformed Contents base64');
    }
    if (bytes.byteLength > MAX_CONTENT_BYTES) throw new FileTooLarge('file exceeds 1 MB');
    if (bytes.byteLength !== size) throw new StoreUnavailable('Contents size does not match decoded bytes');
    return { blobSha: sha, bytes, commitSha: atCommit };
  }

  private storeRead(key: string, file: StoredFile): void {
    const size = file.bytes.byteLength;
    // A single oversized entry is never resident: bypass storage rather than churning the bounded cache.
    if (size > READ_CACHE_BYTES_LIMIT || this.readCache.has(key)) return;
    while (this.readCache.size >= READ_CACHE_ENTRY_LIMIT || this.readCacheBytes + size > READ_CACHE_BYTES_LIMIT) {
      const oldest = this.readCache.entries().next();
      if (oldest.done) break;
      const [oldKey, old] = oldest.value;
      this.readCache.delete(oldKey);
      this.readCacheBytes -= old.bytes.byteLength;
    }
    this.readCache.set(key, { blobSha: file.blobSha, bytes: file.bytes.slice() });
    this.readCacheBytes += size;
  }

  async listDir(dir: string, atCommit: string): Promise<readonly string[]> {
    guardPath(dir);
    // All entry types: an existing directory name is as taken as a file name (rerun Astra N1).
    return ((await this.treeEntries(atCommit, dir)) ?? []).map((e) => e.path);
  }

  async listFiles(dir: string, atCommit: string): Promise<readonly ListedFile[]> {
    if (dir !== '') guardPath(dir);
    // Recursive tree of `<commit>:<dir>`; a truncated tree throws FileTooLarge (fail closed). Regular files only: the
    // Contents API follows a symlink to its target, so a symlink here could read a note outside the allowlist.
    return ((await this.treeEntries(atCommit, dir, true)) ?? [])
      .filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755'))
      .map((e) => ({ path: dir === '' ? e.path : `${dir}/${e.path}`, blobSha: e.sha }));
  }

  /**
   * Entries directly inside `dir` at `commit` (Trees API at `<commit>:<dir>`, probe 2026-09-25 Q5; with `recursive`,
   * every entry below it, paths relative to `dir`), or `null` only when
   * `dir` is **confirmed absent** from its parent tree. Any other 404 or failure throws — fail closed (rerun Opus N1).
   */
  private async treeEntries(commit: string, dir: string, recursive = false): Promise<TreeEntry[] | null> {
    const key = `${commit}\0${dir}\0${recursive ? 'r' : ''}`;
    if (this.listings.has(key)) return this.listings.get(key)!;
    const settled = await this.fetchTreeEntries(commit, dir, recursive);
    if (this.listings.size >= CACHE_LIMIT) this.listings.clear();
    this.listings.set(key, settled);
    return settled;
  }

  private async fetchTreeEntries(commit: string, dir: string, recursive: boolean): Promise<TreeEntry[] | null> {
    const ref = dir === '' ? commit : `${commit}:${dir.split('/').map(encodeURIComponent).join('/')}`;
    const t = await this.getJson<{ sha: string; truncated: boolean; tree: TreeEntry[] }>(`/git/trees/${ref}${recursive ? '?recursive=1' : ''}`);
    if (t) {
      if (t.truncated) throw new FileTooLarge('directory listing truncated');
      // The root listing names the commit's tree: a later write on this commit needs no base-commit read.
      if (dir === '' && /^[0-9a-f]{40}$/.test(commit)) this.rememberTree(commit, t.sha);
      return t.tree;
    }
    if (dir === '') throw new StoreUnavailable('commit tree not found');
    const cut = dir.lastIndexOf('/');
    const parent = await this.treeEntries(commit, cut < 0 ? '' : dir.slice(0, cut));
    if (parent === null || !parent.some((e) => e.path === dir.slice(cut + 1))) return null;
    throw new StoreUnavailable('directory listing failed although the directory exists');
  }

  private rememberTree(commit: string, tree: string): void {
    if (this.trees.size >= CACHE_LIMIT) this.trees.clear();
    this.trees.set(commit, tree);
  }

  /** POST to the Git object endpoints: failures here leave only unreachable objects, never a durable effect. */
  private async createObject<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.call('POST', path, body);
    } catch {
      throw new StoreUnavailable('network error creating a Git object');
    }
    if (res.status !== 201) throw new StoreUnavailable(`GitHub POST ${path} status ${res.status}`);
    return (await res.json()) as T;
  }

  async writeFile(req: WriteRequest): Promise<WriteResult> {
    const r = await this.writeFiles({ baseCommit: req.baseCommit, files: [req], message: req.message, trailers: req.trailers });
    return r.ok ? { ok: true, commitSha: r.commitSha, blobSha: r.blobShas[0]! } : r;
  }

  /** One file costs exactly what the single-file write always did; each extra file adds one blob (+ one listing per new folder). */
  async writeFiles(req: MultiWriteRequest): Promise<MultiWriteResult> {
    assertDistinctFiles(req);
    for (const f of req.files) guardPath(f.path);
    // Precondition against the pinned tree (rerun Astra N1 / Opus N1, N7): a supplied tree entry REPLACES whatever is at
    // the path in `base_tree`, so creation must prove absence and updates must prove a regular 100644 file.
    for (const f of req.files) {
      const cut = f.path.lastIndexOf('/');
      const siblings = await this.treeEntries(req.baseCommit, cut < 0 ? '' : f.path.slice(0, cut));
      const entry = siblings?.find((e) => e.path === f.path.slice(cut + 1));
      const satisfied = f.expect === 'absent' ? entry === undefined : entry?.type === 'blob' && entry.mode === '100644';
      if (!satisfied) return { ok: false, reason: 'precondition-failed' };
    }
    // Head-CAS (ADR-0011, probe 2026-09-25): blobs → tree on X's tree → commit parented on X → fast-forward ref.
    let baseTree = this.trees.get(req.baseCommit);
    if (baseTree === undefined) {
      const base = await this.getJson<{ tree: { sha: string } }>(`/git/commits/${req.baseCommit}`);
      if (!base) throw new StoreUnavailable('base commit not found');
      baseTree = base.tree.sha;
    }
    const blobShas: string[] = [];
    for (const f of req.files) {
      blobShas.push((await this.createObject<{ sha: string }>('/git/blobs', { content: bytesToBase64(f.bytes), encoding: 'base64' })).sha);
    }
    const tree = await this.createObject<{ sha: string }>('/git/trees', {
      base_tree: baseTree,
      tree: req.files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobShas[i] })),
    });
    const trailers = Object.entries(req.trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const commit = await this.createObject<{ sha: string }>('/git/commits', {
      message: `${req.message}\n\n${trailers}\n`,
      tree: tree.sha,
      parents: [req.baseCommit],
    });
    // Only this request can make the effect durable; a lost response here is an unknown outcome (call() throws it).
    const res = await this.call('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
    if (res.status === 200) return { ok: true, commitSha: commit.sha, blobShas };
    // Probed: 422 "Update is not a fast forward" when the head moved past X (including the A2 ABA case).
    if (res.status === 422 || res.status === 409) return { ok: false, reason: 'head-moved' };
    if (res.status >= 500) throw new StoreUnknownOutcome(`GitHub ref update status ${res.status}`);
    throw new StoreUnavailable(`GitHub ref update status ${res.status}`);
  }

  async findOperation(baseCommitSha: string, untilCommit: string, operationId: string, key: string = TRAILER_OP): Promise<FindOperationResult> {
    // Probe 2026-09-25 Q6: unpaged compare returns the NEWEST 250 commits; `per_page=250&page=n` pages oldest-first.
    let seen = 0;
    for (let page = 1; page <= this.maxPages; page++) {
      const cmp = await this.getJson<{ status: string; total_commits: number; commits: { sha: string; commit: { message: string } }[] }>(
        `/compare/${baseCommitSha}...${untilCommit}?per_page=250&page=${page}`,
      );
      if (!cmp) return { kind: 'unknown', reason: 'base commit unknown' };
      if (cmp.status !== 'ahead' && cmp.status !== 'identical') return { kind: 'unknown', reason: `base is not an ancestor (${cmp.status})` };
      for (const c of cmp.commits) {
        const t = parseTrailers(c.commit.message);
        if (t[key] === operationId) {
          const detail = await this.getJson<{ files?: { filename: string }[] }>(`/commits/${c.sha}`);
          return { kind: 'found', op: { commitSha: c.sha, payloadHash: t[TRAILER_PAYLOAD] ?? '', paths: (detail?.files ?? []).map((f) => f.filename) } };
        }
      }
      seen += cmp.commits.length;
      if (seen >= cmp.total_commits) return { kind: 'not-found' };
      if (cmp.commits.length === 0) return { kind: 'unknown', reason: 'compare page empty before all commits were seen' };
    }
    return { kind: 'unknown', reason: 'window truncated' };
  }

  async readCommit(commitSha: string): Promise<CommitInfo | null> {
    // One request (REST commit): message, parents, tree and changed files with their blob SHAs.
    const res = await this.call('GET', `/commits/${encodeURIComponent(commitSha)}`);
    // 404 unknown, 422 "No commit found for SHA": a token that names no commit.
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new StoreUnavailable(`GitHub GET status ${res.status}`);
    const c = (await res.json()) as {
      sha: string;
      parents: { sha: string }[];
      commit: { message: string; tree: { sha: string } };
      files?: { filename: string; sha: string | null; status: string }[];
    };
    this.rememberTree(c.sha, c.commit.tree.sha);
    return {
      sha: c.sha,
      parent: c.parents[0]?.sha ?? null,
      trailers: parseTrailers(c.commit.message),
      files: (c.files ?? []).map((f) => ({ path: f.filename, blobSha: f.status === 'removed' ? null : f.sha })),
    };
  }

  async commitsSince(base: string, until: string): Promise<CommitsSinceResult> {
    // One compare page, oldest-first (probe 2026-09-25 Q6); `total_commits` says whether it holds them all. Never paged.
    const res = await this.call('GET', `/compare/${base}...${until}?per_page=${COMPARE_PAGE}&page=1`);
    if (res.status === 404 || res.status === 422) return { kind: 'not-ancestor' };
    if (!res.ok) throw new StoreUnavailable(`GitHub GET status ${res.status}`);
    const cmp = (await res.json()) as {
      status: string;
      total_commits: number;
      commits: { sha: string; commit: { message: string; tree: { sha: string } } }[];
    };
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') return { kind: 'not-ancestor' };
    if (cmp.total_commits > COMPARE_PAGE || cmp.commits.length < cmp.total_commits) return { kind: 'too-many' };
    for (const c of cmp.commits) this.rememberTree(c.sha, c.commit.tree.sha);
    return { kind: 'ok', commits: cmp.commits.map((c) => ({ sha: c.sha, trailers: parseTrailers(c.commit.message) })) };
  }

  async isAncestor(commit: string, head: string): Promise<boolean> {
    // Status describes the whole comparison on every page; changed files (and patches) occur only on page 1.
    // Page 2 also returns status when its commits are empty (identical/behind/one ahead). ADR-0016 / O7 probe.
    const cmp = await this.getJson<{ status: string }>(`/compare/${commit}...${head}?per_page=1&page=2`);
    return cmp !== null && (cmp.status === 'ahead' || cmp.status === 'identical');
  }

  async parentOf(commitSha: string): Promise<string> {
    const c = await this.getJson<{ parents: { sha: string }[] }>(`/git/commits/${commitSha}`);
    const parent = c?.parents[0]?.sha;
    if (!parent) throw new StoreUnavailable('no parent');
    return parent;
  }
}

/** Defence in depth (security.md#paths): adapters re-check every path even though callers validated it. */
export function guardPath(path: string): void {
  if (!isStructurallySafePath(path)) throw new StoreUnavailable('unsafe vault path rejected by adapter');
}

/** Git trailer block = last paragraph of `Key: value` lines. */
export function parseTrailers(message: string): Record<string, string> {
  const paragraphs = message.replace(/\r\n/g, '\n').trimEnd().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : '';
  const out: Record<string, string> = {};
  for (const line of last.split('\n')) {
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (!m) return {};
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function copyStored(file: { blobSha: string; bytes: Uint8Array }, atCommit: string): StoredFile {
  return { blobSha: file.blobSha, bytes: file.bytes.slice(), commitSha: atCommit };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
