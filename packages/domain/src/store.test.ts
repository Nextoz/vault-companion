// readOnlyAt: the pinned, read-only view one composed read hands to its readers. Synthetic fixtures only.
import { describe, expect, it, vi } from 'vitest';
import { readOnlyAt } from './store.ts';
import { parseVaultPath } from './paths.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const NOTE = 'Inbox/Synthetic.md';

describe('readOnlyAt', () => {
  it('answers head with the pinned commit without asking the store, and reads through it', async () => {
    const store = await InMemoryStore.create({ [NOTE]: 'synthetic body\n' });
    const pinned = store.headCommit;
    const head = vi.spyOn(store, 'head');
    const view = readOnlyAt(store, pinned);

    expect(await view.head()).toEqual({ commitSha: pinned });
    expect(await view.head()).toEqual({ commitSha: pinned });
    expect(head).not.toHaveBeenCalled();
    expect(new TextDecoder().decode((await view.readFile(parseVaultPath(NOTE)!, pinned))!.bytes)).toBe('synthetic body\n');
    expect(await view.listDir('Inbox', pinned)).toEqual(['Synthetic.md']);
  });

  it('refuses every write, so a pinned head is never the base of one', async () => {
    const store = await InMemoryStore.create({ [NOTE]: 'synthetic body\n' });
    const view = readOnlyAt(store, store.headCommit);
    const before = store.headCommit;
    const write = vi.spyOn(store, 'writeFile');

    expect(() => view.writeFile({} as never)).toThrow(/read-only/);
    expect(() => view.writeFiles({} as never)).toThrow(/read-only/);
    expect(() => view.deleteFile({} as never)).toThrow(/read-only/);
    expect(write).not.toHaveBeenCalled();
    expect(store.headCommit).toBe(before);
  });
});
