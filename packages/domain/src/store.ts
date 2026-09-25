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

export interface WriteRequest {
  readonly path: VaultPath;
  /**
   * The pinned commit X the change was computed against (ADR-0011). The new commit is parented on X and the branch
   * only advances if its head is still exactly X; any later commit — even one restoring identical bytes — fails.
   */
  readonly baseCommit: string;
  readonly bytes: Uint8Array;
  /** Commit subject/body. Must never contain task or note text. */
  readonly message: string;
  readonly trailers: Readonly<Record<string, string>>;
}

export type WriteResult =
  | { readonly ok: true; readonly commitSha: string; readonly blobSha: string }
  | { readonly ok: false; readonly reason: 'head-moved' };

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

export interface VaultStore {
  /** Resolve the vault branch to one immutable commit X. Every read of an attempt uses X (review F1). */
  head(): Promise<{ commitSha: string }>;
  /** Read `path` at commit `atCommit`. `null` when absent. */
  readFile(path: VaultPath, atCommit: string): Promise<StoredFile | null>;
  /** Names (not paths) of files directly inside `dir` at `atCommit`. */
  listDir(dir: string, atCommit: string): Promise<readonly string[]>;
  /** Single-file commit parented on `baseCommit`; publishes only as a fast-forward from it (head-CAS, ADR-0011). */
  writeFile(req: WriteRequest): Promise<WriteResult>;
  /** Find a commit in `baseCommitSha..untilCommit` whose trailers carry `operationId`. */
  findOperation(baseCommitSha: string, untilCommit: string, operationId: string): Promise<FindOperationResult>;
  /** True when `commit` is `head` or an ancestor of it; false when not or unknown. */
  isAncestor(commit: string, head: string): Promise<boolean>;
  /** Parent commit SHA (first parent), used to replay an operation on `C^` when deriving effects. */
  parentOf(commitSha: string): Promise<string>;
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
/** Value format: `sha256:<lowercase hex>` of the JCS-canonical submitted envelope. */
export const TRAILER_PAYLOAD = 'Vault-Companion-Payload';
