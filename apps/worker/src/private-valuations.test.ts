import { StoreUnavailable, type VaultStore } from '@vault-companion/domain';
import { InMemoryStore } from '@vault-companion/domain/testing';
import { describe, expect, it } from 'vitest';
import { PRIVATE_VALUATIONS_PATH, createPrivateValuationsReader, parsePrivateValuationsFile } from './private-valuations.ts';

// Synthetic only: no real company figures or private text ever enter the repo.
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'openai',
  name: 'OpenAI',
  valueUsdBillions: 500,
  asOf: '2026-03-12',
  source: { label: 'Synthetic round report', url: 'https://example.test/openai-round' },
  ...over,
});

const fileBytes = (items: readonly unknown[], over: Record<string, unknown> = {}): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, items, ...over }));

const read = (store: VaultStore) => createPrivateValuationsReader({ store }).readPrivateValuations();

describe('readPrivateValuations (WL4b)', () => {
  it('projects the one file at the fixed path, and only that file', async () => {
    const store = await InMemoryStore.create({
      [PRIVATE_VALUATIONS_PATH]: fileBytes([entry(), entry({ id: 'anthropic', name: 'Anthropic' })]),
      'Automation/Watchlist/decoy.json': fileBytes([entry({ id: 'decoy', name: 'DECOY' })]),
    });
    const result = await read(store);
    expect(result).toEqual({
      status: 'ok',
      revision: await store.head().then((h) => h.commitSha),
      items: [entry(), entry({ id: 'anthropic', name: 'Anthropic' })],
      skipped: 0,
    });
  });

  it('drops each bad entry on its own and counts it: bad https guard, bad date, bad value, duplicate id', async () => {
    const store = await InMemoryStore.create({
      [PRIVATE_VALUATIONS_PATH]: fileBytes([
        entry(),
        entry({ id: 'cleartext', source: { label: 'x', url: 'http://example.test/x' } }),
        entry({ id: 'no-date', asOf: 'not-a-date' }),
        entry({ id: 'zero', valueUsdBillions: 0 }),
        entry({ id: 'negative', valueUsdBillions: -1 }),
        entry({ name: 'OpenAI again' }), // same id ('openai') as the first entry
        entry({ id: 'ok', valueUsdBillions: 12.5 }),
      ]),
    });
    const result = await read(store);
    expect(result).toMatchObject({ status: 'ok', skipped: 5 });
    if (result.status !== 'ok') throw new Error('expected the read to succeed');
    expect(result.items.map((i) => i.id)).toEqual(['openai', 'ok']);
  });

  it('rejects a non-finite value (JSON can not carry it, but a raw object can)', () => {
    const parsed = parsePrivateValuationsFile({ schemaVersion: 1, items: [entry({ valueUsdBillions: Infinity }), entry({ id: 'ok' })] });
    expect(parsed).toMatchObject({ skipped: 1, items: [{ id: 'ok' }] });
  });

  it('an absent file is a typed not-found, never a throw', async () => {
    const store = await InMemoryStore.create({ 'Automation/Watchlist/decoy.json': fileBytes([entry()]) });
    await expect(read(store)).resolves.toEqual({ status: 'not-found' });
  });

  it('invalid JSON on disk is a typed invalid, never a throw', async () => {
    const store = await InMemoryStore.create({ [PRIVATE_VALUATIONS_PATH]: 'not json at all' });
    await expect(read(store)).resolves.toEqual({ status: 'invalid' });
  });

  it('a wrong envelope (missing fields, wrong schema, items not an array) is invalid', async () => {
    for (const raw of [
      JSON.stringify({ schemaVersion: 1 }),
      JSON.stringify({ schemaVersion: 2, items: [] }),
      JSON.stringify({ schemaVersion: 1, items: 'nope' }),
    ]) {
      const store = await InMemoryStore.create({ [PRIVATE_VALUATIONS_PATH]: raw });
      await expect(read(store)).resolves.toEqual({ status: 'invalid' });
    }
  });

  it('a store outage never throws: it reads as an unreadable file', async () => {
    const down = {
      head: async () => { throw new StoreUnavailable('down'); },
      listFiles: async () => [],
      readFile: async () => null,
    } as unknown as VaultStore;
    await expect(read(down)).resolves.toEqual({ status: 'invalid' });
  });
});

describe('parsePrivateValuationsFile', () => {
  it('accepts raw JSON, text and bytes, and rejects anything else', () => {
    const parsed = parsePrivateValuationsFile(fileBytes([entry()]));
    expect(parsed?.items[0]).toEqual(entry());
    expect(parsePrivateValuationsFile(new TextDecoder().decode(fileBytes([entry()])))?.items).toHaveLength(1);
    expect(parsePrivateValuationsFile(JSON.parse(new TextDecoder().decode(fileBytes([entry()]))))?.items).toHaveLength(1);
    expect(parsePrivateValuationsFile('{')).toBeNull();
    expect(parsePrivateValuationsFile(null)).toBeNull();
  });

  // Config/parse guard: the fixture is well formed, and the https/date guards are load-bearing (a broken guard makes
  // the count below wrong, not just the value).
  it('keeps unique ids and requires a source label, an https url and a valid date for every entry', () => {
    const fixture = [entry(), entry({ id: 'anthropic', name: 'Anthropic', asOf: '2025-11-01' })];
    const parsed = parsePrivateValuationsFile({ schemaVersion: 1, items: fixture });
    expect(parsed).not.toBeNull();
    const ids = parsed!.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of parsed!.items) {
      expect(item.source.label.length).toBeGreaterThan(0);
      expect(item.source.url.startsWith('https://')).toBe(true);
      expect(item.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(item.asOf))).toBe(false);
    }
    // The guards are real: a cleartext url and an impossible date are dropped, so removing either guard flips this.
    const guarded = parsePrivateValuationsFile({ schemaVersion: 1, items: [entry({ source: { label: 'x', url: 'http://example.test' } }), entry({ asOf: '2026-13-40' })] });
    expect(guarded).toMatchObject({ skipped: 2, items: [] });
  });
});
