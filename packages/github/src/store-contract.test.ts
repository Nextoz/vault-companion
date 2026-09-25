// One behavioural contract, two implementations: the in-memory test double must behave like real Git.
import { TRAILER_OP, TRAILER_PAYLOAD, TRAILER_UNDOES, type VaultPath, type VaultStore } from '@vault-companion/domain';
import { gitBlobSha, InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitStore } from './local-git-store.ts';
import { createTempRepos, git, type TempRepos } from './git-fixture.ts';

const TODO = 'Tasks/To-Do List.md' as VaultPath;
const SEED = {
  [TODO]: '---\ntitle: x\n---\r\n- [ ] Cykel æøå 📅 2026-09-30\r\n',
  'Inbox/Første note - 2026-09-20.md': 'a\n',
  'Inbox/sub/nested.md': 'n\n',
};
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

interface Harness {
  store: VaultStore;
  external(files: Record<string, string | null>): Promise<string>;
  cleanup(): void;
}

const harnesses: Record<string, (limit?: number) => Promise<Harness>> = {
  memory: async (limit) => {
    const s = await InMemoryStore.create(SEED);
    if (limit) s.dedupeWindowLimit = limit;
    return { store: s, external: (f) => s.commitFiles(f), cleanup: () => {} };
  },
  'local-git': async (limit) => {
    const repos: TempRepos = createTempRepos(SEED);
    const store = new LocalGitStore({ repo: repos.bare, ...(limit ? { dedupeWindowLimit: limit } : {}) });
    return { store, external: async (f) => repos.commitExternal(f), cleanup: () => repos.cleanup() };
  },
};

let current: Harness | null = null;
afterEach(() => current?.cleanup());

const write = (store: VaultStore, path: VaultPath, baseCommit: string, text: string, op = 'op-1', hash = 'sha256:x', expect: 'absent' | 'regular-file' = path.startsWith('Inbox/new') ? 'absent' : 'regular-file') =>
  store.writeFile({ path, baseCommit, expect, bytes: enc(text), message: 'Vault Companion: test', trailers: { [TRAILER_OP]: op, [TRAILER_PAYLOAD]: hash } });

// Real git on Windows spawns many processes per case (3–5 s observed); allow headroom under parallel load.
describe.each(Object.keys(harnesses))('VaultStore contract: %s', { timeout: 30_000 }, (name) => {
  const make = async (limit?: number) => (current = await harnesses[name]!(limit));

  it('reads exact bytes (CRLF, Unicode) and reports the real Git blob SHA', async () => {
    const { store } = await make();
    const { commitSha } = await store.head();
    const f = await store.readFile(TODO, commitSha);
    expect(dec(f!.bytes)).toBe(SEED[TODO]);
    // Git blob SHA (= GitHub Contents API `sha`); against local-git this pins gitBlobSha to real Git.
    expect(f!.blobSha).toBe(await gitBlobSha(f!.bytes));
    expect(await store.readFile('Inbox/missing.md' as VaultPath, commitSha)).toBeNull();
  });

  it('lists all direct children, files and directories, with Unicode names (rerun Astra N1)', async () => {
    const { store } = await make();
    const names = await store.listDir('Inbox', (await store.head()).commitSha);
    expect([...names].sort()).toEqual(['Første note - 2026-09-20.md', 'sub']);
  });

  it('head-CAS (ADR-0011): writes from the current head succeed; any later commit makes a write from the old head fail', async () => {
    const { store, external } = await make();
    const x = (await store.head()).commitSha;
    const blob = (await store.readFile(TODO, x))!.blobSha;
    const ok = await write(store, TODO, x, 'v2');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(await store.parentOf(ok.commitSha)).toBe(x); // parented on the pinned commit
    const y = (await store.head()).commitSha;
    await external({ 'Inbox/other.md': 'o' }); // an unrelated file: blob CAS would have let the next write pass
    expect(await write(store, TODO, y, 'v3', 'op-2')).toEqual({ ok: false, reason: 'head-moved' });
    const head = (await store.head()).commitSha;
    expect(dec((await store.readFile(TODO, head))!.bytes)).toBe('v2');
    expect(await store.readFile(TODO, x)).toMatchObject({ blobSha: blob }); // history is immutable
  });

  it('precondition (rerun Astra N1 / Opus N1): create never replaces a file or a directory; update needs a regular file', async () => {
    const { store } = await make();
    const x = (await store.head()).commitSha;
    const fail = { ok: false, reason: 'precondition-failed' };
    expect(await write(store, 'Inbox/Første note - 2026-09-20.md' as VaultPath, x, 'x', 'op', 'h', 'absent')).toEqual(fail);
    expect(await write(store, 'Inbox/sub' as VaultPath, x, 'x', 'op', 'h', 'absent')).toEqual(fail); // a directory
    expect(await write(store, 'Inbox/missing.md' as VaultPath, x, 'x', 'op', 'h', 'regular-file')).toEqual(fail);
    expect(await write(store, 'Inbox/sub' as VaultPath, x, 'x', 'op', 'h', 'regular-file')).toEqual(fail);
    expect((await store.head()).commitSha).toBe(x); // nothing written
    expect(dec((await store.readFile('Inbox/sub/nested.md' as VaultPath, x))!.bytes)).toBe(SEED['Inbox/sub/nested.md']);
    expect((await write(store, 'Inbox/new.md' as VaultPath, x, 'x', 'op', 'h', 'absent')).ok).toBe(true);
  });

  it('listing fails closed: [] only for a directory that is provably absent', async () => {
    const { store } = await make();
    const x = (await store.head()).commitSha;
    expect(await store.listDir('Nowhere', x)).toEqual([]);
    await expect(store.listDir('Inbox', 'f'.repeat(40))).rejects.toThrow();
  });

  it('A2 ABA: identical bytes restored after X do not let a delayed write from X land', async () => {
    const { store, external } = await make();
    const x = (await store.head()).commitSha;
    const original = SEED[TODO]!;
    expect((await write(store, TODO, x, 'completed', 'op-C')).ok).toBe(true); // first delivery of C
    await external({ [TODO]: original }); // Undo restores the exact original bytes
    const restored = (await store.head()).commitSha;
    expect((await store.readFile(TODO, restored))!.blobSha).toBe((await store.readFile(TODO, x))!.blobSha);
    expect(await write(store, TODO, x, 'completed', 'op-C')).toEqual({ ok: false, reason: 'head-moved' }); // delayed duplicate
    expect(dec((await store.readFile(TODO, (await store.head()).commitSha))!.bytes)).toBe(original);
  });

  it.each(['../outside.md', 'Tasks/../../x.md', '/abs.md', `Inbox${String.fromCharCode(92)}x.md`, 'Inbox/%2e%2e.md', `Inbox/x${String.fromCharCode(0x85)}.md`, ''])(
    'adapter rejects unsafe path %j before touching Git (security.md#paths)',
    async (bad) => {
      const { store } = await make();
      const x = (await store.head()).commitSha;
      await expect(store.readFile(bad as VaultPath, x)).rejects.toThrow('unsafe vault path');
      await expect(write(store, bad as VaultPath, x, 'x')).rejects.toThrow('unsafe vault path');
      expect((await store.head()).commitSha).toBe(x);
    },
  );

  it('findOperation: found with payload hash and changed paths; not-found; parentOf', async () => {
    const { store } = await make();
    const base = (await store.head()).commitSha;
    const w = await write(store, 'Inbox/new.md' as VaultPath, base, 'x', 'op-A', 'sha256:abc');
    const head = (await store.head()).commitSha;
    expect(await store.findOperation(base, head, 'op-A')).toEqual({
      kind: 'found',
      op: { commitSha: w.ok ? w.commitSha : '', payloadHash: 'sha256:abc', paths: ['Inbox/new.md'] },
    });
    expect(await store.findOperation(base, head, 'op-B')).toEqual({ kind: 'not-found' });
    expect(await store.findOperation(head, head, 'op-A')).toEqual({ kind: 'not-found' }); // window excludes base
    expect(await store.parentOf(head)).toBe(base);
    expect(await store.isAncestor(base, head)).toBe(true);
    expect(await store.isAncestor(head, head)).toBe(true);
    expect(await store.isAncestor(head, base)).toBe(false);
  });

  it('findOperation honours a non-default trailer key (gate-3 F1: the Undoes guard must not go inert)', async () => {
    const { store } = await make();
    const base = (await store.head()).commitSha;
    await store.writeFile({
      path: 'Inbox/new.md' as VaultPath,
      baseCommit: base,
      expect: 'absent',
      bytes: enc('x'),
      message: 'Vault Companion: test',
      trailers: { [TRAILER_OP]: 'undo-op', [TRAILER_PAYLOAD]: 'sha256:u', [TRAILER_UNDOES]: 'target-op' },
    });
    const head = (await store.head()).commitSha;
    expect((await store.findOperation(base, head, 'target-op', TRAILER_UNDOES)).kind).toBe('found');
    expect((await store.findOperation(base, head, 'target-op')).kind).toBe('not-found'); // default key is Op
    expect((await store.findOperation(base, head, 'undo-op', TRAILER_UNDOES)).kind).toBe('not-found');
  });

  it('listing a path that is a file is a failure, never "absent" (gate-3 F2)', async () => {
    const { store } = await make();
    await expect(store.listDir('Tasks/To-Do List.md', (await store.head()).commitSha)).rejects.toThrow();
  });

  it('findOperation: unknown for an unknown base and for a truncated window', async () => {
    const { store, external } = await make(2);
    const base = (await store.head()).commitSha;
    const head1 = (await store.head()).commitSha;
    expect((await store.findOperation('f'.repeat(40), head1, 'op')).kind).toBe('unknown');
    for (let i = 0; i < 3; i++) await external({ 'Inbox/x.md': `v${i}\n` });
    expect((await store.findOperation(base, (await store.head()).commitSha, 'op')).kind).toBe('unknown');
  });
});

describe('LocalGitStore mode precondition (gate-3 F2, mutant M13)', { timeout: 30_000 }, () => {
  it('refuses to update a file stored as 100755 (the write would silently change its mode)', async () => {
    const repos = createTempRepos(SEED);
    current = { store: new LocalGitStore({ repo: repos.bare }), external: async () => '', cleanup: () => repos.cleanup() };
    const writer = `${repos.root}/writer`;
    git(writer, 'pull', '-q', '--ff-only');
    git(writer, 'update-index', '--chmod=+x', 'Tasks/To-Do List.md');
    git(writer, 'commit', '-q', '-m', 'make executable');
    git(writer, 'push', '-q', 'origin', 'main');
    const store = current.store;
    const x = (await store.head()).commitSha;
    expect(await write(store, TODO, x, 'v2', 'op', 'h', 'regular-file')).toEqual({ ok: false, reason: 'precondition-failed' });
    expect((await store.head()).commitSha).toBe(x);
  });
});
