// VaultStore port: the only way domain code touches durable vault state.
// Adapters: packages/github (GitHubContentsStore, LocalGitStore) and InMemoryStore (tests).
// Semantics are specified in docs/architecture.md#vaultstore-port and docs/commands.md.

/** Vault-relative, '/'-separated path that has passed `parseVaultPath`. */
export type VaultPath = string & { readonly __brand: 'VaultPath' };

export interface StoredFile {
  readonly blobSha: string;
  readonly bytes: Uint8Array;
  /** HEAD commit the file was read at. */
  readonly commitSha: string;
}

export interface ListedFile {
  readonly path: string;
  readonly blobSha: string;
}

export interface WriteRequest {
  readonly path: VaultPath;
  /**
   * The pinned commit X the change was computed against (ADR-0011). The new commit is parented on X and the branch
   * only advances as a fast-forward from X; any later commit — even one restoring identical bytes — fails. (GitHub also
   * accepts a fast-forward from an ancestor of X after a rewind; out of contract, see ADR-0011.)
   */
  readonly baseCommit: string;
  /**
   * What must be at `path` in the base tree (rerun review Astra N1 / Opus N1, N7). A Git Data write replaces whatever is
   * at the path, so creation must prove absence (no file, no directory, any case is the caller's job) and updates must
   * prove a regular file (mode 100644). Checked by the adapter against `baseCommit`, never against a listing.
   */
  readonly expect: 'absent' | 'regular-file';
  readonly bytes: Uint8Array;
  /** Commit subject/body. Must never contain task or note text. */
  readonly message: string;
  readonly trailers: Readonly<Record<string, string>>;
}

export type WriteResult =
  | { readonly ok: true; readonly commitSha: string; readonly blobSha: string }
  | { readonly ok: false; readonly reason: 'head-moved' | 'precondition-failed' };

export interface FoundOperation {
  readonly commitSha: string;
  readonly payloadHash: string;
  /** Files changed by that commit (app commits touch exactly one). */
  readonly paths: readonly string[];
}

export type FindOperationResult =
  | { readonly kind: 'found'; readonly op: FoundOperation }
  | { readonly kind: 'not-found' }
  /** Window could not be searched completely (truncation, unknown or non-ancestor base). Never write. */
  | { readonly kind: 'unknown'; readonly reason: string };

/** One commit as the Undo token check needs it (ADR-0013). */
export interface CommitInfo {
  readonly sha: string;
  /** First parent; null for a root commit. */
  readonly parent: string | null;
  readonly trailers: Readonly<Record<string, string>>;
  /** Files the commit changed (vs. its first parent) with their blob SHA after the commit; null for a deletion. */
  readonly files: readonly { readonly path: string; readonly blobSha: string | null }[];
}

/** A commit listed by `commitsSince` (trailers only; details via `readCommit`). */
export interface ListedCommit {
  readonly sha: string;
  readonly trailers: Readonly<Record<string, string>>;
}

export type CommitsSinceResult =
  | { readonly kind: 'ok'; readonly commits: readonly ListedCommit[] }
  /** `base` is unknown or not an ancestor of `until` (e.g. a forged or rewritten-away token). */
  | { readonly kind: 'not-ancestor' }
  /**
   * More than one page (`COMPARE_PAGE` commits) lies between them. Never paged (ADR-0013). Answered only when `base`
   * IS an ancestor of `until`: ancestry is decided before any listing (task reads rely on it, review O1).
   */
  | { readonly kind: 'too-many' };

/** One compare page (GitHub's maximum `per_page`). */
export const COMPARE_PAGE = 250;

export interface VaultStore {
  /** Resolve the vault branch to one immutable commit X. Every read of an attempt uses X (review F1). */
  head(): Promise<{ commitSha: string }>;
  /** Read `path` at commit `atCommit`. `null` when absent. */
  readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null>;
  /**
   * Names of ALL entries (files and directories) directly inside `dir` at `atCommit`; `[]` only when `dir` is confirmed
   * absent. Any other failure throws (fail closed — rerun review Opus N1).
   */
  listDir(dir: string, atCommit: string): Promise<readonly string[]>;
  /**
   * Every **regular file** (Git mode 100644/100755; never symlinks, submodules or directories) anywhere below `dir` at
   * `atCommit`, as full vault-relative paths with their blob SHAs. `[]` only when `dir` is confirmed absent; a truncated
   * listing throws `FileTooLarge`; any other failure throws (fail closed). Used to resolve linked notes (P4-A).
   */
  listFiles(dir: string, atCommit: string): Promise<readonly ListedFile[]>;
  /** Single-file commit parented on `baseCommit`; publishes only as a fast-forward from it (head-CAS, ADR-0011). */
  writeFile(req: WriteRequest): Promise<WriteResult>;
  /** Find a commit in `baseCommitSha..untilCommit` whose trailer `key` (default `Vault-Companion-Op`) equals `value`. */
  findOperation(baseCommitSha: string, untilCommit: string, value: string, key?: string): Promise<FindOperationResult>;
  /** True when `commit` is `head` or an ancestor of it; false when not or unknown. */
  isAncestor(commit: string, head: string): Promise<boolean>;
  /** Parent commit SHA (first parent), used to replay an operation on `C^` when deriving effects. */
  parentOf(commitSha: string): Promise<string>;
  /** One commit's trailers, parent and changed files; `null` when the commit does not exist. One request. */
  readCommit(commitSha: string): Promise<CommitInfo | null>;
  /**
   * The commits in `base..until` (excluding `base`) if they fit in one page of `COMPARE_PAGE`; one request, no paging.
   * `until === base` is `ok` with no commits.
   */
  commitsSince(base: string, until: string): Promise<CommitsSinceResult>;
}

/** Git blob SHA-1 of `bytes` (= the GitHub Contents API `sha`). */
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header);
  buf.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Upstream unreachable before the request could have taken effect. Safe to retry later. */
export class StoreUnavailable extends Error {
  override readonly name = 'StoreUnavailable';
}

/** The write may or may not have been applied (timeout, dropped connection, 5xx after send). */
export class StoreUnknownOutcome extends Error {
  override readonly name = 'StoreUnknownOutcome';
}

/** File exceeds what the adapter can read with byte fidelity (> 1 MB via Contents API). */
export class FileTooLarge extends Error {
  override readonly name = 'FileTooLarge';
}

export const TRAILER_OP = 'Vault-Companion-Op';
/** On an Undo commit: the operation ID of the completion it undid (rerun review Opus N6). */
export const TRAILER_UNDOES = 'Vault-Companion-Undoes';
/** Value format: `sha256:<lowercase hex>` of the JCS-canonical submitted envelope. */
export const TRAILER_PAYLOAD = 'Vault-Companion-Payload';
