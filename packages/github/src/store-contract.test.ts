// One behavioural contract, two implementations: the in-memory test double must behave like real Git.
import { TRAILER_OP, TRAILER_PAYLOAD, type VaultPath, type VaultStore } from '@vault-companion/domain';
import { gitBlobSha, InMemoryStore } from '@vault-companion/domain/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalGitStore } from './local-git-store.ts';
import { createTempRepos, type TempRepos } from './git-fixture.ts';

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

const write = (store: VaultStore, path: VaultPath, expected: string | null, text: string, op = 'op-1', hash = 'sha256:x') =>
  store.writeFile({ path, expectedBlobSha: expected, bytes: enc(text), message: 'Vault Companion: test', trailers: { [TRAILER_OP]: op, [TRAILER_PAYLOAD]: hash } });

describe.each(Object.keys(harnesses))('VaultStore contract: %s', (name) => {
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

  it('lists direct file children only, with Unicode names', async () => {
    const { store } = await make();
    const names = await store.listDir('Inbox', (await store.head()).commitSha);
    expect([...names].sort()).toEqual(['Første note - 2026-09-20.md']);
  });

  it('CAS: succeeds on the expected blob, fails after the file changed, succeeds when only another file changed', async () => {
    const { store, external } = await make();
    const x = (await store.head()).commitSha;
    const blob = (await store.readFile(TODO, x))!.blobSha;
    await external({ 'Inbox/other.md': 'o\n' }); // head moves, file unchanged
    const ok = await write(store, TODO, blob, 'v2\n');
    expect(ok.ok).toBe(true);
    const stale = await write(store, TODO, blob, 'v3\n', 'op-2');
    expect(stale).toEqual({ ok: false, reason: 'cas-mismatch' });
    const head = (await store.head()).commitSha;
    expect(dec((await store.readFile(TODO, head))!.bytes)).toBe('v2\n');
    expect(await store.readFile(TODO, x)).toMatchObject({ blobSha: blob }); // history is immutable
  });

  it('create fails when the path exists', async () => {
    const { store } = await make();
    expect(await write(store, 'Inbox/Første note - 2026-09-20.md' as VaultPath, null, 'x')).toEqual({ ok: false, reason: 'exists' });
    expect((await write(store, 'Inbox/new.md' as VaultPath, null, 'x')).ok).toBe(true);
  });

  it('findOperation: found with payload hash and changed paths; not-found; parentOf', async () => {
    const { store } = await make();
    const base = (await store.head()).commitSha;
    const w = await write(store, 'Inbox/new.md' as VaultPath, null, 'x', 'op-A', 'sha256:abc');
    const head = (await store.head()).commitSha;
    expect(await store.findOperation(base, head, 'op-A')).toEqual({
      kind: 'found',
      op: { commitSha: w.ok ? w.commitSha : '', payloadHash: 'sha256:abc', paths: ['Inbox/new.md'] },
    });
    expect(await store.findOperation(base, head, 'op-B')).toEqual({ kind: 'not-found' });
    expect(await store.findOperation(head, head, 'op-A')).toEqual({ kind: 'not-found' }); // window excludes base
    expect(await store.parentOf(head)).toBe(base);
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
