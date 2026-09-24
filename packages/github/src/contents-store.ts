// VaultStore over the GitHub REST API (Contents, Git refs/commits, Compare). Runs on Workers (fetch only).
// Response shapes for reads were captured in Phase 0 (docs/discovery/phase-0-findings.md). Write/conflict
// semantics marked ASSUMED are unverified until gate G1 (disposable private repo) — see docs/testing.md.
import {
  FileTooLarge,
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
} from '@vault-companion/domain';

export interface GitHubStoreOptions {
  readonly owner: string;
  readonly repo: string;
  readonly branch?: string;
  /** Returns a current installation token (see github-app-token.ts). Never logged. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
  /** GitHub compare returns at most 250 commits without pagination. */
  readonly dedupeWindowLimit?: number;
}

const MAX_CONTENT_BYTES = 1024 * 1024;

export class GitHubContentsStore implements VaultStore {
  private readonly branch: string;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly limit: number;

  constructor(private readonly opts: GitHubStoreOptions) {
    this.branch = opts.branch ?? 'main';
    this.f = opts.fetch ?? fetch;
    this.base = `${opts.apiBase ?? 'https://api.github.com'}/repos/${opts.owner}/${opts.repo}`;
    this.limit = Math.min(opts.dedupeWindowLimit ?? 250, 250);
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

  async head(): Promise<{ commitSha: string }> {
    const ref = await this.getJson<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!ref) throw new StoreUnavailable('branch not found');
    return { commitSha: ref.object.sha };
  }

  async readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null> {
    const item = await this.getJson<{ type: string; sha: string; size: number; content?: string; encoding?: string }>(
      `${this.contentsPath(path)}?ref=${atCommit}`,
    );
    if (!item) return null;
    if (item.type !== 'file') return null;
    if (item.size > MAX_CONTENT_BYTES || item.encoding !== 'base64' || item.content === undefined) throw new FileTooLarge('file exceeds 1 MB');
    // Phase 0: base64 arrives with embedded '\n' every 60 chars.
    const bytes = base64ToBytes(item.content.replace(/\s/g, ''));
    return { blobSha: item.sha, bytes, commitSha: atCommit };
  }

  async listDir(dir: string, atCommit: string): Promise<readonly string[]> {
    const items = await this.getJson<{ type: string; name: string }[]>(`${this.contentsPath(dir)}?ref=${atCommit}`);
    return Array.isArray(items) ? items.filter((i) => i.type === 'file').map((i) => i.name) : [];
  }

  async writeFile(req: WriteRequest): Promise<WriteResult> {
    const trailers = Object.entries(req.trailers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const body: Record<string, unknown> = {
      message: `${req.message}\n\n${trailers}\n`,
      content: bytesToBase64(req.bytes),
      branch: this.branch,
    };
    if (req.expectedBlobSha !== null) body.sha = req.expectedBlobSha;
    const res = await this.call('PUT', this.contentsPath(req.path), body);
    if (res.status === 200 || res.status === 201) {
      const json = (await res.json()) as { content: { sha: string }; commit: { sha: string } };
      return { ok: true, commitSha: json.commit.sha, blobSha: json.content.sha };
    }
    // ASSUMED (G1): 409 = sha does not match the file's current blob.
    if (res.status === 409) return { ok: false, reason: 'cas-mismatch' };
    // ASSUMED (G1): 422 without sha = file already exists; with sha, treat as a CAS loss to force re-dedupe.
    if (res.status === 422) return { ok: false, reason: req.expectedBlobSha === null ? 'exists' : 'cas-mismatch' };
    if (res.status >= 500) throw new StoreUnknownOutcome(`GitHub PUT status ${res.status}`);
    throw new StoreUnavailable(`GitHub PUT status ${res.status}`);
  }

  async findOperation(baseCommitSha: string, untilCommit: string, operationId: string): Promise<FindOperationResult> {
    const cmp = await this.getJson<{ status: string; total_commits: number; commits: { sha: string; commit: { message: string } }[] }>(
      `/compare/${baseCommitSha}...${untilCommit}?per_page=${this.limit}`,
    );
    if (!cmp) return { kind: 'unknown', reason: 'base commit unknown' };
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') return { kind: 'unknown', reason: `base is not an ancestor (${cmp.status})` };
    for (const c of cmp.commits) {
      const t = parseTrailers(c.commit.message);
      if (t[TRAILER_OP] === operationId) {
        const detail = await this.getJson<{ files?: { filename: string }[] }>(`/commits/${c.sha}`);
        return { kind: 'found', op: { commitSha: c.sha, payloadHash: t[TRAILER_PAYLOAD] ?? '', paths: (detail?.files ?? []).map((f) => f.filename) } };
      }
    }
    if (cmp.total_commits > cmp.commits.length) return { kind: 'unknown', reason: 'window truncated' };
    return { kind: 'not-found' };
  }

  async parentOf(commitSha: string): Promise<string> {
    const c = await this.getJson<{ parents: { sha: string }[] }>(`/git/commits/${commitSha}`);
    const parent = c?.parents[0]?.sha;
    if (!parent) throw new StoreUnavailable('no parent');
    return parent;
  }
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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
