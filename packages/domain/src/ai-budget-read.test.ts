import { AiBudgetResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { AI_BUDGET_PATH, createAiBudgetReadService, parseAiBudgetFile } from './ai-budget-read.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'claude',
  label: 'Claude weekly',
  kind: 'percent',
  value: 58,
  limit: 100,
  unit: null,
  resetsAt: '2026-10-05T04:00:00+02:00',
  history: [40, 44, 50, 58],
  ...over,
});

const fileBytes = (over: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    schema: 1,
    generatedAt: '2026-10-03T06:31:00+02:00',
    providers: [provider()],
    freeRamGb: 12.5,
    ...over,
  }));

const read = (store: VaultStore) => createAiBudgetReadService({ store }).readAiBudget();

describe('readAiBudget (AB2)', () => {
  it('projects the one budget file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [AI_BUDGET_PATH]: fileBytes(),
      'Automation/Scout Status/decoy.json': fileBytes({ providers: [provider({ label: 'DECOY' })] }),
    });
    const result = await read(store);
    expect(AiBudgetResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      generatedAt: '2026-10-03T06:31:00+02:00',
      providers: [provider()],
      freeRamGb: 12.5,
    });
  });

  it('drops only a provider with an unknown id or kind, keeping the rest', async () => {
    const store = await InMemoryStore.create({
      [AI_BUDGET_PATH]: fileBytes({
        providers: [
          provider({ id: 'claude', label: 'Claude weekly' }),
          provider({ id: 'mystery', label: 'Unknown vendor' }),
          provider({ id: 'codex', label: 'Codex monthly', kind: 'credits' }),
          provider({ id: 'deepseek', label: 'DeepSeek', value: 'many' }),
          provider({ id: 'scaleway', label: 'Scaleway credits', kind: 'money', value: 6.14, unit: '$' }),
        ],
      }),
    });
    const result = await read(store);
    expect(result).toMatchObject({ providers: [{ id: 'claude' }, { id: 'scaleway' }] });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Automation/Scout Status/decoy.json': fileBytes() });
    await expect(read(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
  });

  it('invalid JSON on disk is a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [AI_BUDGET_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid' });
  });

  it('a wrong envelope (missing or unknown fields, wrong schema) is invalid', async () => {
    for (const raw of [
      JSON.stringify({ schema: 1, generatedAt: '2026-10-03T06:31:00+02:00' }),
      JSON.stringify({ schema: 2, generatedAt: '2026-10-03T06:31:00+02:00', providers: [], freeRamGb: null }),
      JSON.stringify({ schema: 1, generatedAt: '2026-10-03T06:31:00+02:00', providers: [], freeRamGb: null, extra: true }),
    ]) {
      const store = await InMemoryStore.create({ [AI_BUDGET_PATH]: raw });
      await expect(read(store)).resolves.toMatchObject({ code: 'invalid' });
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
    const store = await InMemoryStore.create({ [AI_BUDGET_PATH]: fileBytes() });
    const { commitSha } = await store.head();
    expect(await read(store)).toMatchObject({ revision: commitSha });
  });
});

describe('parseAiBudgetFile', () => {
  it('accepts raw JSON, text and bytes, and rejects anything else', () => {
    expect(parseAiBudgetFile(JSON.parse(new TextDecoder().decode(fileBytes())))?.freeRamGb).toBe(12.5);
    expect(parseAiBudgetFile(new TextDecoder().decode(fileBytes()))?.providers).toHaveLength(1);
    expect(parseAiBudgetFile(fileBytes())?.providers).toHaveLength(1);
    expect(parseAiBudgetFile('{')).toBeNull();
    expect(parseAiBudgetFile(null)).toBeNull();
  });

  it('keeps a provider with a null limit, unit, resetsAt and history', () => {
    const parsed = parseAiBudgetFile(fileBytes({ providers: [provider({ limit: null, unit: null, resetsAt: null, history: null })] }));
    expect(parsed?.providers[0]).toMatchObject({ limit: null, unit: null, resetsAt: null, history: null });
  });
});
