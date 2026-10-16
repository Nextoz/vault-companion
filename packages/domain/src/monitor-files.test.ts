import { VaultActivityResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { createVaultActivityReadService, VAULT_ACTIVITY_PATH } from './monitor-files.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

// Synthetic values, real vault-activity schema (M6a): a small 3-day window of the fixture shape.
const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-16',
  notes: 5,
  areas: { Events: 1, Learning: 1, '(root)': 1, Health: 2 },
  ...over,
});

const file = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1,
  generatedAt: '2026-10-16T05:40:12+02:00',
  source: 'vault git history',
  windowDays: 3,
  start: '2026-10-14',
  end: '2026-10-16',
  days: [
    day({ date: '2026-10-14', notes: 11, areas: { Events: 2, '(root)': 3, Health: 3, Learning: 2, Career: 1 } }),
    day({ date: '2026-10-15', notes: 3, areas: { Health: 2, Projects: 1 } }),
    day(),
  ],
  currentStreak: 23,
  notesThisMonth: 79,
  areas30d: [{ area: 'Projects', notes: 28 }, { area: 'Health', notes: 27 }],
  excluded: ['Automation/', 'Tools/', '.obsidian/'],
  ...over,
});

const fileBytes = (over: Record<string, unknown> = {}): Uint8Array => new TextEncoder().encode(JSON.stringify(file(over)));

const read = (store: VaultStore) => createVaultActivityReadService({ store }).readVaultActivity();

describe('readVaultActivity (M6a)', () => {
  it('projects the one activity file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [VAULT_ACTIVITY_PATH]: fileBytes(),
      'Automation/Monitors/decoy.json': fileBytes({ currentStreak: 999, notesThisMonth: 1 }),
    });
    const result = await read(store);
    expect(VaultActivityResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      ...file(),
    });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Automation/Monitors/decoy.json': fileBytes() });
    await expect(read(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
  });

  it('invalid JSON on disk is a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
  });

  it('bytes that are not valid UTF-8 are a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: new Uint8Array([0x22, 0xff, 0xfe, 0x22]) });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
  });

  it('a wrong envelope (unknown fields, wrong schema, bad values) is invalid', async () => {
    for (const raw of [
      JSON.stringify(file({ schema: 2 })),
      JSON.stringify(file({ windowDays: 'many' })),
      JSON.stringify(file({ days: [{ date: '16-10-2026', notes: 1, areas: {} }] })),
      JSON.stringify(file({ currentStreak: -1 })),
      JSON.stringify({ ...file(), extra: true }),
    ]) {
      const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: raw });
      await expect(read(store)).resolves.toMatchObject({ code: 'invalid', retryable: false });
    }
  });

  it('a store outage is a retryable upstream-unavailable, never a throw', async () => {
    const down = {
      head: async () => { throw new StoreUnavailable('down'); },
      listFiles: async () => [],
      readFile: async () => null,
    } as unknown as VaultStore;
    await expect(read(down)).resolves.toMatchObject({ code: 'upstream-unavailable', retryable: true });
  });

  it('surfaces the revision the read was pinned to', async () => {
    const store = await InMemoryStore.create({ [VAULT_ACTIVITY_PATH]: fileBytes() });
    const { commitSha } = await store.head();
    expect(await read(store)).toMatchObject({ revision: commitSha, currentStreak: 23 });
  });
});
