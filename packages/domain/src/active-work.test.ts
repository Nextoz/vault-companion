// Active Work Now (brief P4-D): fixed path, one pinned commit, regular file only, 1 MB guard, absent is not an error.
import { ACTIVE_WORK_PATH, MAX_NOTE_BYTES, type ActiveWorkResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createActiveWorkService } from './active-work.ts';
import { StoreUnavailable, type StoredFile, type VaultPath } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const TODO = 'Tasks/To-Do List.md';
const TEXT = '# Now\n\n- Ship the [[Garden]] plan\n';

async function readWith(files: Record<string, string | Uint8Array>, tweak?: (s: InMemoryStore) => void) {
  const store = await InMemoryStore.create({ [TODO]: '## Open\n\n## Done\n', ...files });
  tweak?.(store);
  const r = await createActiveWorkService({ store }).readActiveWork();
  return { r, store };
}
const ok = (r: unknown) => r as ActiveWorkResponse;

describe('Active Work Now', () => {
  it('returns the raw Markdown with the pinned revision and blob', async () => {
    const { r, store } = await readWith({ [ACTIVE_WORK_PATH]: TEXT });
    expect(r).toMatchObject({ status: 'ok', revision: store.headCommit, markdown: TEXT });
    expect(ok(r).status === 'ok' && ok(r)).toMatchObject({ blobSha: (await store.readFile(ACTIVE_WORK_PATH as VaultPath, store.headCommit))!.blobSha });
  });

  it('a missing file is `absent`, not an error (also when Tasks/ itself is missing)', async () => {
    expect((await readWith({})).r).toMatchObject({ status: 'absent' });
    const store = await InMemoryStore.create({ 'Inbox/x.md': 'x\n' });
    expect(await createActiveWorkService({ store }).readActiveWork()).toMatchObject({ status: 'absent' });
  });

  it('1 MB guard: 1 MB + 1 byte ⇒ too-large; exactly 1 MB is readable', async () => {
    expect((await readWith({ [ACTIVE_WORK_PATH]: new Uint8Array(MAX_NOTE_BYTES + 1).fill(0x61) })).r).toMatchObject({ status: 'refused', code: 'too-large' });
    expect((await readWith({ [ACTIVE_WORK_PATH]: new Uint8Array(MAX_NOTE_BYTES).fill(0x61) })).r).toMatchObject({ status: 'ok' });
  });

  it('a truncated Tasks/ listing ⇒ too-large (regular-file status cannot be proven)', async () => {
    const { r } = await readWith({ [ACTIVE_WORK_PATH]: TEXT, 'Tasks/a.md': 'a' }, (s) => (s.listFilesLimit = 1));
    expect(r).toMatchObject({ status: 'refused', code: 'too-large' });
  });

  it('invalid UTF-8 ⇒ encoding', async () => {
    expect((await readWith({ [ACTIVE_WORK_PATH]: new Uint8Array([0xff, 0xfe, 0x41]) })).r).toMatchObject({ status: 'refused', code: 'encoding' });
  });

  it('bytes that are not the listed regular file (a followed symlink) are never returned', async () => {
    const { r } = await readWith({ [ACTIVE_WORK_PATH]: TEXT }, (s) => {
      const real = s.readFile.bind(s);
      s.readFile = async (p: VaultPath, at: string): Promise<StoredFile | null> => {
        const f = await real(p, at);
        return f && { ...f, blobSha: 'e'.repeat(40), bytes: new TextEncoder().encode('SECRET-ELSEWHERE') };
      };
    });
    expect(r).toMatchObject({ status: 'absent' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('every read is pinned to one commit: an edit landing mid-request is not seen', async () => {
    const { r, store } = await readWith({ [ACTIVE_WORK_PATH]: TEXT }, (s) => {
      s.afterHead = async () => {
        s.afterHead = null;
        await s.commitFiles({ [ACTIVE_WORK_PATH]: 'NEWER\n' });
      };
    });
    expect(r).toMatchObject({ status: 'ok', markdown: TEXT });
    expect(ok(r).revision).not.toBe(store.headCommit);
  });

  it('store outage ⇒ retryable upstream-unavailable', async () => {
    const { r } = await readWith({ [ACTIVE_WORK_PATH]: TEXT }, (s) => {
      s.listFiles = async () => {
        throw new StoreUnavailable('down');
      };
    });
    expect(r).toEqual({ code: 'upstream-unavailable', message: expect.any(String), retryable: true });
  });
});
