import { AiUsageResponse } from '@vault-companion/contracts';
import { describe, expect, it } from 'vitest';
import { AI_USAGE_PATH, createAiUsageReadService, parseAiUsageFile } from './ai-usage-read.ts';
import { StoreUnavailable, type VaultStore } from './store.ts';
import { InMemoryStore } from './testing/in-memory-store.ts';

const day = (over: Record<string, unknown> = {}) => ({
  date: '2026-10-01',
  calls: 3,
  inputTokens: 100,
  outputTokens: 200,
  cacheWriteTokens: 10,
  cacheReadTokens: 20,
  cost: 0.42,
  ...over,
});

const provider = (over: Record<string, unknown> = {}) => ({
  label: 'Claude',
  currency: 'USD',
  days: [day()],
  since: '2026-09-01',
  ...over,
});

const fileBytes = (providers: Record<string, unknown>, over: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({
    schema: 1,
    generatedAt: '2026-10-04T06:31:00+02:00',
    providers,
    ...over,
  }));

const read = (store: VaultStore) => createAiUsageReadService({ store }).readAiUsage();

describe('readAiUsage (AB3a)', () => {
  it('projects the one usage file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [AI_USAGE_PATH]: fileBytes({ claude: provider() }),
      'AI/Usage/decoy.json': fileBytes({ claude: provider({ label: 'DECOY' }) }),
    });
    const result = await read(store);
    expect(AiUsageResponse.parse(result)).toEqual({
      revision: await store.head().then((h) => h.commitSha),
      generatedAt: '2026-10-04T06:31:00+02:00',
      providers: { claude: provider() },
      skipped: 0,
    });
  });

  it('keeps an unknown provider id and drops only a malformed provider, counting it in skipped', async () => {
    const store = await InMemoryStore.create({
      [AI_USAGE_PATH]: fileBytes({
        claude: provider(),
        mystery: provider({ label: 'Unknown vendor' }),
        broken: { label: 'Broken', days: 'not-an-array' },
        codex: provider({ label: 'Codex' }),
      }),
    });
    const result = await read(store);
    expect(result).toMatchObject({ providers: { claude: {}, mystery: {}, codex: {} }, skipped: 1 });
    expect(Object.keys((result as { providers: Record<string, unknown> }).providers)).toEqual(['claude', 'mystery', 'codex']);
  });

  it('drops only a malformed day, keeping the provider and its good days', async () => {
    const store = await InMemoryStore.create({
      [AI_USAGE_PATH]: fileBytes({
        claude: provider({ days: [day({ date: '2026-10-01' }), { date: 'not-a-date', calls: 1 }, day({ date: '2026-10-02' }), day({ calls: -1 })] }),
      }),
    });
    const result = await read(store);
    expect(result).toMatchObject({ skipped: 2, providers: { claude: { days: [{ date: '2026-10-01' }, { date: '2026-10-02' }] } } });
  });

  it('ignores unknown extra fields at every level instead of failing the file', async () => {
    const store = await InMemoryStore.create({
      [AI_USAGE_PATH]: fileBytes({ claude: provider({ extra: 'x', days: [day({ extra: 1 })] }) }, { extraTop: true }),
    });
    const projected = AiUsageResponse.parse(await read(store));
    expect(projected).toMatchObject({ skipped: 0, providers: { claude: { label: 'Claude', days: [{ date: '2026-10-01' }] } } });
    expect(projected.providers.claude).not.toHaveProperty('extra');
    expect(projected.providers.claude?.days[0]).not.toHaveProperty('extra');
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'AI/Usage/decoy.json': fileBytes({ claude: provider() }) });
    await expect(read(store)).resolves.toMatchObject({ code: 'not-found', retryable: false });
  });

  it('invalid JSON on disk is a typed invalid error, never a throw', async () => {
    const store = await InMemoryStore.create({ [AI_USAGE_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toMatchObject({ code: 'invalid' });
  });

  it('a wrong envelope (missing fields, wrong schema, providers not an object) is invalid', async () => {
    for (const raw of [
      JSON.stringify({ schema: 1, providers: {} }),
      JSON.stringify({ schema: 2, generatedAt: '2026-10-04T06:31:00+02:00', providers: {} }),
      JSON.stringify({ schema: 1, generatedAt: '2026-10-04T06:31:00+02:00', providers: [] }),
    ]) {
      const store = await InMemoryStore.create({ [AI_USAGE_PATH]: raw });
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
    const store = await InMemoryStore.create({ [AI_USAGE_PATH]: fileBytes({ claude: provider() }) });
    const { commitSha } = await store.head();
    expect(await read(store)).toMatchObject({ revision: commitSha });
  });
});

describe('parseAiUsageFile', () => {
  it('accepts raw JSON, text and bytes, and rejects anything else', () => {
    expect(parseAiUsageFile(JSON.parse(new TextDecoder().decode(fileBytes({ claude: provider() }))))?.providers.claude?.label).toBe('Claude');
    expect(parseAiUsageFile(new TextDecoder().decode(fileBytes({ claude: provider() })))?.providers.claude?.days).toHaveLength(1);
    expect(parseAiUsageFile(fileBytes({ claude: provider() }))?.providers.claude?.days).toHaveLength(1);
    expect(parseAiUsageFile('{')).toBeNull();
    expect(parseAiUsageFile(null)).toBeNull();
  });

  it('keeps optional provider fields absent without counting them as skipped', () => {
    const parsed = parseAiUsageFile(fileBytes({ claude: { days: [] } }));
    expect(parsed).toMatchObject({ skipped: 0, providers: { claude: { days: [] } } });
    expect(parsed?.providers.claude).not.toHaveProperty('label');
  });
});